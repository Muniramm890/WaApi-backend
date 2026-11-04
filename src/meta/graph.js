'use strict';
// Thin Meta Graph API client with typed errors, timeouts and safe retries.
const cfg = require('../config');
const log = require('../lib/logger');

const RETRYABLE_CODES = new Set([1, 2, 4, 17, 32, 613, 80007, 130429, 131000, 131016, 133004, 133016]);
const AUTH_CODES = new Set([190, 102, 463, 467, 10, 200, 100000]);

class MetaError extends Error {
  constructor(httpStatus, err = {}) {
    super(err.error_user_msg || err.message || 'Meta API error');
    this.name = 'MetaError';
    this.httpStatus = httpStatus;
    this.code = err.code;
    this.subcode = err.error_subcode;
    this.type = err.type;
    this.title = err.error_user_title;
    this.fbtraceId = err.fbtrace_id;
    this.details = err.error_data && err.error_data.details;
  }
  get retryable() { return this.httpStatus >= 500 || RETRYABLE_CODES.has(this.code); }
  get isAuth() { return this.httpStatus === 401 || (this.code !== undefined && AUTH_CODES.has(this.code) && this.type === 'OAuthException'); }
  get isRateLimit() { return [4, 17, 32, 613, 80007, 130429, 131056].includes(this.code); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (path, query) => {
  const p = path.startsWith('http') ? path : `${cfg.meta.graphBase}/${/^v\d+\.\d+\//.test(path) ? '' : cfg.meta.apiVersion + '/'}${path.replace(/^\//, '')}`;
  const u = new URL(p);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  return u.toString();
};

// opts: { token, query, body, form (FormData), timeout, retries, raw (return Buffer) }
async function graph(method, path, opts = {}) {
  const { token, query, body, form, timeout = 20000, raw = false } = opts;
  const retries = opts.retries !== undefined ? opts.retries : method === 'GET' ? 2 : 0;
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }

  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url(path, query), { method, headers, body: payload, signal: ctl.signal });
      if (raw && res.ok) return Buffer.from(await res.arrayBuffer());
      const text = await res.text(); let json;
      try { json = text ? JSON.parse(text) : {}; } catch { json = { error: { message: text.slice(0, 300) } }; }
      if (!res.ok || json.error) throw new MetaError(res.status, json.error || {});
      return json;
    } catch (e) {
      const err = e.name === 'AbortError' ? Object.assign(new MetaError(504, { message: 'Meta API timed out' }), { timedOut: true }) : e;
      const transient = err instanceof MetaError ? err.retryable : true;
      if (attempt < retries && transient) { await sleep(400 * 2 ** attempt + Math.random() * 200); continue; }
      if (!(err instanceof MetaError)) { log.warn('graph network error', { path, msg: err.message }); throw new MetaError(503, { message: 'Could not reach Meta: ' + err.message }); }
      throw err;
    } finally { clearTimeout(t); }
  }
}

// follow paging.cursors.after until exhausted (bounded)
async function graphAll(path, opts = {}, maxPages = 20) {
  const out = []; let after;
  for (let i = 0; i < maxPages; i++) {
    const r = await graph('GET', path, { ...opts, query: { ...(opts.query || {}), limit: 100, after } });
    out.push(...(r.data || []));
    after = r.paging && r.paging.next && r.paging.cursors && r.paging.cursors.after;
    if (!after) break;
  }
  return out;
}
module.exports = { graph, graphAll, MetaError };
