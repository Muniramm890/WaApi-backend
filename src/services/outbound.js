'use strict';
// Outbound webhooks to tenants: signed, retried with backoff, SSRF-guarded.
const db = require('../db');
const log = require('../lib/logger');
const { E } = require('../lib/errors');
const { encrypt, decrypt, hmac, randomHex, randomToken } = require('../lib/crypto');
const { validateWebhookUrl, postJson } = require('../lib/ssrf');
const tenantsSvc = require('./tenants');

const EVENT_TYPES = ['message.status', 'message.received', 'template.status', 'number.quality', 'account.update', 'webhook.test'];
const BACKOFF_SEC = [30, 120, 600, 3600, 21600, 86400];
const MAX_ATTEMPTS = BACKOFF_SEC.length + 1;
const DISABLE_AFTER = 40;

const shapeEp = (e) => ({ id: e.id, url: e.url, events: e.events === '*' ? ['*'] : e.events.split(','), status: e.status, description: e.description, consecutive_failures: e.consecutive_failures, last_success_at: e.last_success_at, last_failure_at: e.last_failure_at, disabled_reason: e.disabled_reason, created_at: e.created_at });
function parseEvents(events) {
  if (!events || (Array.isArray(events) && !events.length) || events === '*') return '*';
  const arr = Array.isArray(events) ? events : String(events).split(',');
  const bad = arr.filter((x) => x !== '*' && !EVENT_TYPES.includes(x));
  if (bad.length) throw E.bad(`Unknown event type(s): ${bad.join(', ')}`);
  return arr.includes('*') ? '*' : arr.join(',');
}

async function createEndpoint(tenantId, plan, { url, events, description }) {
  const err = validateWebhookUrl(url); if (err) throw E.bad(err);
  await tenantsSvc.assertWithinLimit(plan, tenantId, 'webhooks');
  const secret = 'whsec_' + randomToken(24); const now = new Date();
  const id = await db.insert('webhook_endpoints', { tenant_id: tenantId, url, secret_enc: encrypt(secret), events: parseEvents(events), status: 'active', description: description || null, consecutive_failures: 0, created_at: now, updated_at: now });
  return { ...shapeEp(await db.one('SELECT * FROM webhook_endpoints WHERE id = ?', [id])), secret }; // secret shown once
}
async function updateEndpoint(tenantId, id, { url, events, description, status }) {
  const ep = await db.one('SELECT * FROM webhook_endpoints WHERE id = ? AND tenant_id = ?', [id, tenantId]);
  if (!ep) throw E.notFound('Webhook endpoint');
  const f = { updated_at: new Date() };
  if (url !== undefined) { const err = validateWebhookUrl(url); if (err) throw E.bad(err); f.url = url; }
  if (events !== undefined) f.events = parseEvents(events);
  if (description !== undefined) f.description = description;
  if (status !== undefined) { if (!['active', 'disabled'].includes(status)) throw E.bad('"status" must be active or disabled'); f.status = status; if (status === 'active') { f.consecutive_failures = 0; f.disabled_reason = null; } }
  await db.update('webhook_endpoints', f, 'id = ?', [id]);
  return shapeEp(await db.one('SELECT * FROM webhook_endpoints WHERE id = ?', [id]));
}
async function rotateSecret(tenantId, id) {
  const secret = 'whsec_' + randomToken(24);
  const n = await db.update('webhook_endpoints', { secret_enc: encrypt(secret), updated_at: new Date() }, 'id = ? AND tenant_id = ?', [id, tenantId]);
  if (!n) throw E.notFound('Webhook endpoint');
  return { secret };
}
const listEndpoints = async (tenantId) => (await db.query('SELECT * FROM webhook_endpoints WHERE tenant_id = ? ORDER BY id', [tenantId])).map(shapeEp);
async function deleteEndpoint(tenantId, id) {
  const ep = await db.one('SELECT id FROM webhook_endpoints WHERE id = ? AND tenant_id = ?', [id, tenantId]);
  if (!ep) throw E.notFound('Webhook endpoint');
  await db.run('DELETE FROM webhook_deliveries WHERE endpoint_id = ?', [id]);
  await db.run('DELETE FROM webhook_endpoints WHERE id = ?', [id]);
}

// Fan an event out to every active, subscribed endpoint of the tenant (queued; dispatcher sends).
async function emit(tenantId, type, data) {
  try {
    const eps = await db.query("SELECT id, events FROM webhook_endpoints WHERE tenant_id = ? AND status = 'active'", [tenantId]);
    const now = new Date();
    for (const ep of eps) {
      if (ep.events !== '*' && !ep.events.split(',').includes(type)) continue;
      const eventId = 'evt_' + randomHex(12);
      const payload = JSON.stringify({ id: eventId, type, created_at: now.toISOString(), data });
      try { await db.insert('webhook_deliveries', { tenant_id: tenantId, endpoint_id: ep.id, event_id: eventId, event_type: type, payload, state: 'pending', attempts: 0, next_attempt_at: now, created_at: now }); }
      catch (e) { if (!db.isUnique(e)) throw e; }
    }
  } catch (e) { log.error('emit event failed', e); }
}

async function attempt(d) {
  const ep = await db.one('SELECT * FROM webhook_endpoints WHERE id = ?', [d.endpoint_id]);
  const now = new Date(); const attempts = d.attempts + 1;
  if (!ep || ep.status !== 'active') { await db.update('webhook_deliveries', { state: 'failed', attempts, last_error: 'Endpoint missing or disabled' }, 'id = ?', [d.id]); return false; }
  let status = null; let error = null;
  try {
    const ts = Math.floor(Date.now() / 1000);
    const sig = hmac(decrypt(ep.secret_enc), `${ts}.${d.payload}`);
    const r = await postJson(ep.url, d.payload, { 'X-WAP-Event': d.event_type, 'X-WAP-Delivery': d.event_id, 'X-WAP-Signature': `t=${ts},v1=${sig}` });
    status = r.status; if (status < 200 || status >= 300) error = `HTTP ${status}: ${String(r.body).slice(0, 200)}`;
  } catch (e) { error = String(e.message).slice(0, 300); }
  if (!error) {
    await db.update('webhook_deliveries', { state: 'delivered', attempts, last_status: status, last_error: null, delivered_at: now }, 'id = ?', [d.id]);
    await db.update('webhook_endpoints', { consecutive_failures: 0, last_success_at: now }, 'id = ?', [ep.id]);
    return true;
  }
  const exhausted = attempts >= MAX_ATTEMPTS;
  await db.update('webhook_deliveries', { state: exhausted ? 'failed' : 'pending', attempts, last_status: status, last_error: error, next_attempt_at: exhausted ? null : new Date(Date.now() + BACKOFF_SEC[Math.min(attempts - 1, BACKOFF_SEC.length - 1)] * 1000) }, 'id = ?', [d.id]);
  const fails = ep.consecutive_failures + 1;
  await db.update('webhook_endpoints', fails >= DISABLE_AFTER ? { consecutive_failures: fails, last_failure_at: now, status: 'disabled', disabled_reason: 'Disabled automatically after repeated delivery failures' } : { consecutive_failures: fails, last_failure_at: now }, 'id = ?', [ep.id]);
  return false;
}
// Claim-then-send so several instances never double-send.
async function dispatchDue(batch = 50) {
  const now = new Date(); const l = db.lim(batch);
  const due = await db.query(`SELECT ${l.top} * FROM webhook_deliveries WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY id ${l.tail}`, [now]);
  let sent = 0;
  await Promise.all(due.map(async (d) => {
    const claimed = await db.update('webhook_deliveries', { next_attempt_at: new Date(Date.now() + 90000) }, "id = ? AND state = 'pending' AND next_attempt_at <= ?", [d.id, now]);
    if (!claimed) return;
    try { await attempt(d); sent++; } catch (e) { log.error('webhook attempt crashed', e); }
  }));
  return sent;
}
async function sendTest(tenantId, endpointId) {
  const ep = await db.one('SELECT * FROM webhook_endpoints WHERE id = ? AND tenant_id = ?', [endpointId, tenantId]);
  if (!ep) throw E.notFound('Webhook endpoint');
  const now = new Date(); const eventId = 'evt_' + randomHex(12);
  const id = await db.insert('webhook_deliveries', { tenant_id: tenantId, endpoint_id: ep.id, event_id: eventId, event_type: 'webhook.test', payload: JSON.stringify({ id: eventId, type: 'webhook.test', created_at: now.toISOString(), data: { message: 'Test event from WA Platform' } }), state: 'pending', attempts: 0, next_attempt_at: now, created_at: now });
  const d = await db.one('SELECT * FROM webhook_deliveries WHERE id = ?', [id]);
  const ok = await attempt(d);
  const after = await db.one('SELECT * FROM webhook_deliveries WHERE id = ?', [id]);
  if (!ok) await db.update('webhook_deliveries', { state: 'failed', next_attempt_at: null }, 'id = ?', [id]); // tests are not retried
  return { ok, status: after.last_status, error: after.last_error };
}
async function retryDelivery(tenantId, id) {
  const n = await db.update('webhook_deliveries', { state: 'pending', attempts: 0, next_attempt_at: new Date() }, 'id = ? AND tenant_id = ?', [id, tenantId]);
  if (!n) throw E.notFound('Delivery');
}
async function listDeliveries(tenantId, { endpointId, state, limit = 50, before } = {}) {
  const w = ['tenant_id = ?']; const p = [tenantId];
  if (endpointId) { w.push('endpoint_id = ?'); p.push(endpointId); }
  if (state) { w.push('state = ?'); p.push(state); }
  if (before) { w.push('id < ?'); p.push(before); }
  const l = db.lim(limit);
  return db.query(`SELECT ${l.top} id, endpoint_id, event_id, event_type, state, attempts, last_status, last_error, created_at, delivered_at FROM webhook_deliveries WHERE ${w.join(' AND ')} ORDER BY id DESC ${l.tail}`, p);
}
module.exports = { EVENT_TYPES, emit, dispatchDue, createEndpoint, updateEndpoint, rotateSecret, listEndpoints, deleteEndpoint, sendTest, retryDelivery, listDeliveries };
