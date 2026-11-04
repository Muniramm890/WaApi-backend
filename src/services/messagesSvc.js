'use strict';
const db = require('../db');
const { E } = require('../lib/errors');
const { normalizeWaId } = require('../lib/phone');
const { take } = require('../lib/ratelimit');
const { MetaError } = require('../meta/graph');
const M = require('../meta/messaging');
const wabas = require('./wabas');
const tpl = require('./templatesSvc');
const usage = require('./usage');
const billing = require('./billing');
const tenantsSvc = require('./tenants');

const WINDOW_MS = 24 * 3600 * 1000;
const CATS = { marketing: 'marketing', utility: 'utility', authentication: 'authentication' };

const shape = (m) => ({
  id: m.id, direction: m.direction, wamid: m.wamid, wa_id: m.wa_id, type: m.msg_type, template: m.template_name ? { name: m.template_name, language: m.template_lang } : undefined,
  category: m.category, pricing_category: m.pricing_category, billable: !!m.billable, status: m.status, preview: m.body_preview,
  error: m.error_code ? { code: m.error_code, message: m.error_message } : undefined, client_ref: m.client_ref,
  created_at: m.created_at, sent_at: m.sent_at, delivered_at: m.delivered_at, read_at: m.read_at, failed_at: m.failed_at,
  phone_number_id: m.phone_row_id,
});

async function upsertContact(tenantId, waId, { name, inboundAt } = {}) {
  const now = new Date();
  let c = await db.one('SELECT * FROM contacts WHERE tenant_id = ? AND wa_id = ?', [tenantId, waId]);
  if (!c) {
    try { const id = await db.insert('contacts', { tenant_id: tenantId, wa_id: waId, profile_name: name || null, last_inbound_at: inboundAt || null, opted_out: 0, created_at: now, updated_at: now }); return db.one('SELECT * FROM contacts WHERE id = ?', [id]); }
    catch (e) { if (!db.isUnique(e)) throw e; c = await db.one('SELECT * FROM contacts WHERE tenant_id = ? AND wa_id = ?', [tenantId, waId]); }
  }
  if (name || inboundAt) {
    const f = { updated_at: now }; if (name) f.profile_name = name; if (inboundAt) f.last_inbound_at = inboundAt;
    await db.update('contacts', f, 'id = ?', [c.id]); Object.assign(c, f);
  }
  return c;
}

function mapSendError(e) {
  if (!(e instanceof MetaError)) return e;
  const d = { meta_code: e.code, meta_subcode: e.subcode, fbtrace_id: e.fbtraceId };
  if (e.isRateLimit) return E.tooMany('WhatsApp throughput/rate limit reached for this number', 2);
  if (e.isAuth) return E.conflict('The WhatsApp access token is no longer valid. Reconnect the account.', 'WABA_TOKEN_INVALID', d);
  const known = { 131047: ['OUTSIDE_WINDOW', 'More than 24 hours since the customer last replied. Use an approved template.'], 131026: ['UNDELIVERABLE', 'Recipient is not a WhatsApp user or cannot receive this message'], 132001: ['TEMPLATE_NOT_FOUND', 'Template does not exist in this language on this WhatsApp account'], 131030: ['RECIPIENT_NOT_ALLOWED', 'Recipient is not in the allowed list for this number'], 131031: ['ACCOUNT_LOCKED', 'This WhatsApp account is locked by Meta'], 133010: ['NUMBER_NOT_REGISTERED', 'Phone number is not registered on Cloud API'], 131042: ['PAYMENT_ISSUE', 'There is a payment issue on the WhatsApp Business Account (add a payment method in Meta)'], 131049: ['ECOSYSTEM_LIMIT', 'Meta limited this marketing message to protect user experience'] };
  if ([132000, 132005, 132007, 132012, 132015, 132016].includes(e.code)) return E.unprocessable('TEMPLATE_PARAMS_INVALID', e.message, d);
  if (known[e.code]) return E.unprocessable(known[e.code][0], known[e.code][1], d);
  if (e.httpStatus >= 500) return E.upstream('WhatsApp is temporarily unavailable', d);
  return E.unprocessable('META_ERROR', e.message, d);
}

// ctx: { tenant, plan, actor, apiKeyId?, source }
async function send(ctx, input) {
  const { tenant, plan } = ctx;
  tenantsSvc.assertOperational(tenant);
  const to = normalizeWaId(input.to);
  if (!to) throw E.unprocessable('INVALID_RECIPIENT', '"to" must be a valid phone number with country code');
  const clientRef = input.client_ref ? String(input.client_ref).slice(0, 100) : null;
  if (clientRef) {
    const prev = await db.one('SELECT * FROM messages WHERE tenant_id = ? AND client_ref = ?', [tenant.id, clientRef]);
    if (prev) return { ...shape(prev), idempotent_replay: true };
  }
  const { phone, waba } = await wabas.resolveSender(tenant.id, input.from);
  const token = wabas.tokenOf(waba);
  const built = M.build(input, to);
  const contact = await upsertContact(tenant.id, to);

  let category = 'service';
  if (built.type === 'template') {
    const t = await tpl.findApproved(tenant.id, waba.id, built.templateName, built.templateLang);
    if (t) {
      if (t.status !== 'APPROVED') throw E.unprocessable('TEMPLATE_NOT_APPROVED', `Template "${t.name}" is ${t.status}`);
      category = CATS[String(t.category || '').toLowerCase()] || 'utility';
    } else category = 'utility';
    if (category === 'marketing' && contact.opted_out) throw E.conflict('This contact has opted out of marketing messages', 'CONTACT_OPTED_OUT');
  } else if (!(contact.last_inbound_at && Date.now() - new Date(contact.last_inbound_at).getTime() < WINDOW_MS)) {
    throw E.unprocessable('OUTSIDE_WINDOW', 'Free-form messages are only allowed within 24 hours of the customer\'s last message. Send an approved template instead.');
  }
  await billing.assertQuota(ctx);
  const rl = take('pn:' + phone.id, 80);
  if (!rl.ok) throw E.tooMany('Per-number throughput limit reached', rl.retryAfter);

  const now = new Date();
  let id;
  try {
    id = await db.insert('messages', {
      tenant_id: tenant.id, phone_row_id: phone.id, direction: 'out', wa_id: to, msg_type: built.type, template_name: built.templateName || null,
      template_lang: built.templateLang || null, category, billable: 0, body_preview: built.preview, status: 'queued', client_ref: clientRef,
      api_key_id: ctx.apiKeyId || null, source: ctx.source || 'api', created_at: now,
    });
  } catch (e) { // concurrent duplicate client_ref
    if (clientRef && db.isUnique(e)) { const prev = await db.one('SELECT * FROM messages WHERE tenant_id = ? AND client_ref = ?', [tenant.id, clientRef]); return { ...shape(prev), idempotent_replay: true }; }
    throw e;
  }
  try {
    const r = await M.sendRaw(phone.phone_number_id, token, built.payload);
    const wamid = r.messages && r.messages[0] && r.messages[0].id;
    await db.update('messages', { status: 'accepted', wamid: wamid || null, sent_at: new Date() }, 'id = ?', [id]);
    await usage.bump(tenant.id, category, 'sent');
  } catch (e) {
    await db.update('messages', { status: 'failed', error_code: String(e.code || e.httpStatus || 'ERR').slice(0, 20), error_message: String(e.message).slice(0, 500), failed_at: new Date() }, 'id = ?', [id]);
    await usage.bump(tenant.id, category, 'failed');
    if (e instanceof MetaError && e.isAuth) await wabas.markTokenInvalid(waba.id, e.message);
    throw mapSendError(e);
  }
  return shape(await db.one('SELECT * FROM messages WHERE id = ?', [id]));
}

async function sendBatch(ctx, items) {
  if (!Array.isArray(items) || !items.length) throw E.bad('"messages" must be a non-empty array');
  if (items.length > 100) throw E.bad('A batch can contain at most 100 messages');
  const results = new Array(items.length); let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = { index: idx, ok: true, message: await send(ctx, items[idx]) }; }
      catch (e) { results[idx] = { index: idx, ok: false, error: { code: e.code || 'ERROR', message: e.message, details: e.details } }; }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { total: items.length, accepted: results.filter((r) => r.ok).length, results };
}

async function list(tenantId, f = {}) {
  const w = ['tenant_id = ?']; const p = [tenantId];
  const add = (cond, v) => { w.push(cond); p.push(v); };
  if (f.direction) add('direction = ?', f.direction === 'in' ? 'in' : 'out');
  if (f.status) add('status = ?', f.status);
  if (f.wa_id) add('wa_id = ?', normalizeWaId(f.wa_id) || f.wa_id);
  if (f.template) add('template_name = ?', f.template);
  if (f.category) add('category = ?', f.category);
  if (f.from) add('created_at >= ?', new Date(f.from));
  if (f.to) add('created_at <= ?', new Date(f.to));
  if (f.before) add('id < ?', f.before);
  const l = db.lim(f.limit || 50);
  const rows = await db.query(`SELECT ${l.top} * FROM messages WHERE ${w.join(' AND ')} ORDER BY id DESC ${l.tail}`, p);
  return { data: rows.map(shape), next_before: rows.length ? rows[rows.length - 1].id : null };
}
async function get(tenantId, id) {
  const m = await db.one('SELECT * FROM messages WHERE tenant_id = ? AND (id = ? OR wamid = ?)', [tenantId, /^\d{1,15}$/.test(String(id)) ? Number(id) : -1, String(id)]);
  if (!m) throw E.notFound('Message');
  return { ...shape(m), payload: m.payload ? JSON.parse(m.payload) : undefined };
}
async function listContacts(tenantId, { q, before, limit = 50 } = {}) {
  const w = ['tenant_id = ?']; const p = [tenantId];
  if (q) { w.push('(wa_id LIKE ? OR LOWER(profile_name) LIKE ?)'); p.push(`%${String(q).replace(/\D/g, '') || 'x'}%`, `%${String(q).toLowerCase()}%`); }
  if (before) { w.push('id < ?'); p.push(before); }
  const l = db.lim(limit);
  return db.query(`SELECT ${l.top} id, wa_id, profile_name, last_inbound_at, opted_out, opted_out_at, created_at FROM contacts WHERE ${w.join(' AND ')} ORDER BY id DESC ${l.tail}`, p);
}
async function setOptOut(tenantId, waId, optedOut) {
  const id = normalizeWaId(waId); if (!id) throw E.bad('Invalid number');
  const c = await upsertContact(tenantId, id);
  await db.update('contacts', { opted_out: optedOut ? 1 : 0, opted_out_at: optedOut ? new Date() : null, updated_at: new Date() }, 'id = ?', [c.id]);
  return { wa_id: id, opted_out: !!optedOut };
}
async function markRead(ctx, wamid, from) {
  const m = await db.one("SELECT * FROM messages WHERE tenant_id = ? AND wamid = ? AND direction = 'in'", [ctx.tenant.id, String(wamid)]);
  if (!m) throw E.notFound('Inbound message');
  const { phone, waba } = await wabas.resolveSender(ctx.tenant.id, from || m.phone_row_id);
  try { await M.markRead(phone.phone_number_id, wabas.tokenOf(waba), m.wamid); } catch (e) { throw mapSendError(e); }
  await db.update('messages', { status: 'read', read_at: new Date() }, 'id = ?', [m.id]);
}
module.exports = { send, sendBatch, list, get, listContacts, setOptOut, markRead, upsertContact, shape, mapSendError };
