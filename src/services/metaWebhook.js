'use strict';
// Meta webhook pipeline: store raw (signature-checked) -> ACK fast -> process async, idempotent, with retry sweeper.
const cfg = require('../config');
const db = require('../db');
const log = require('../lib/logger');
const { decrypt } = require('../lib/crypto');
const { verifyWebhookSignature } = require('../meta/signature');
const acct = require('../meta/account');
const outbound = require('./outbound');
const usage = require('./usage');
const tplSvc = require('./templatesSvc');
const msgSvc = require('./messagesSvc');
const tenantsSvc = require('./tenants');

class RetryLater extends Error {}
const RANK = { accepted: 0, queued: 0, sent: 1, delivered: 2, read: 3, failed: 9, received: 0 };
const MAX_ATTEMPTS = 8;

async function receive(rawBody, signature) {
  const ok = verifyWebhookSignature(rawBody, signature, cfg.meta.appSecret);
  if (!ok) return { accepted: false };
  const id = await db.insert('webhook_inbox', { received_at: new Date(), signature_ok: 1, payload: rawBody.toString('utf8'), state: 'pending', attempts: 0 });
  setImmediate(() => processRow(id).catch((e) => log.error('inbox process crashed', e)));
  return { accepted: true, id };
}

async function recordEvent(tenantId, wabaId, field, event, value) {
  try { await db.insert('meta_events', { tenant_id: tenantId || null, waba_id: wabaId || null, field, event: event ? String(event).slice(0, 80) : null, payload: JSON.stringify(value).slice(0, 8000), created_at: new Date() }); } catch (e) { log.warn('meta event store failed', { msg: e.message }); }
}
const toDate = (ts) => (ts ? new Date(Number(ts) * 1000) : new Date());

// ---- messages field ----
async function handleMessages(wabaId, value) {
  const pnId = value.metadata && value.metadata.phone_number_id;
  const pn = pnId ? await db.one('SELECT * FROM phone_numbers WHERE phone_number_id = ?', [String(pnId)]) : null;
  if (!pn) { await recordEvent(null, wabaId, 'messages', 'unknown_number', { phone_number_id: pnId }); return; }
  let retry = false;
  for (const st of value.statuses || []) if ((await applyStatus(pn, st)) === 'retry') retry = true;
  for (const m of value.messages || []) await handleInbound(pn, m, value.contacts || []);
  for (const er of value.errors || []) await recordEvent(pn.tenant_id, wabaId, 'messages', 'error', er);
  if (retry) throw new RetryLater('status arrived before message was recorded');
}
async function applyStatus(pn, st) {
  const msg = await db.one('SELECT * FROM messages WHERE wamid = ?', [String(st.id)]);
  if (!msg) return Date.now() - toDate(st.timestamp).getTime() < 10 * 60000 ? 'retry' : 'skip'; // race: webhook beat our DB write
  const next = String(st.status || '').toLowerCase();
  if (!(next in RANK) || next === 'accepted') return 'skip';
  const prev = msg.status; const ts = toDate(st.timestamp); const f = {};
  const pr = st.pricing; if (pr) { f.pricing_category = String(pr.category || '').slice(0, 30) || null; f.billable = pr.billable ? 1 : 0; }
  const advance = next === 'failed' ? prev !== 'failed' : RANK[next] > (RANK[prev] ?? 0);
  if (advance) {
    f.status = next;
    if (next === 'sent') f.sent_at = msg.sent_at || ts;
    if (next === 'delivered') f.delivered_at = ts;
    if (next === 'read') { f.read_at = ts; if (!msg.delivered_at) f.delivered_at = ts; }
    if (next === 'failed') { f.failed_at = ts; const er = (st.errors || [])[0] || {}; f.error_code = String(er.code || 'FAILED').slice(0, 20); f.error_message = String(er.error_data && er.error_data.details || er.message || er.title || 'Delivery failed').slice(0, 500); }
  }
  if (!Object.keys(f).length) return 'skip';
  await db.update('messages', f, 'id = ?', [msg.id]);
  if (advance && msg.direction === 'out') {
    const cat = msg.category || 'unknown';
    if (next === 'delivered' && RANK[prev] < 2) await usage.bump(msg.tenant_id, cat, 'delivered');
    if (next === 'read') { if (RANK[prev] < 2) await usage.bump(msg.tenant_id, cat, 'delivered'); await usage.bump(msg.tenant_id, cat, 'read'); }
    if (next === 'failed') await usage.bump(msg.tenant_id, cat, 'failed');
    await outbound.emit(msg.tenant_id, 'message.status', { id: msg.id, wamid: msg.wamid, to: msg.wa_id, status: next, timestamp: ts.toISOString(), client_ref: msg.client_ref, error: next === 'failed' ? { code: f.error_code, message: f.error_message } : undefined, pricing: pr || undefined });
  }
  return 'ok';
}
function previewOf(m) {
  switch (m.type) {
    case 'text': return m.text && m.text.body;
    case 'button': return m.button && (m.button.text || m.button.payload);
    case 'interactive': { const i = m.interactive || {}; const r = i.button_reply || i.list_reply || {}; return r.title || (i.nfm_reply && 'flow response'); }
    case 'image': case 'video': case 'document': case 'audio': case 'sticker': return `[${m.type}] ${(m[m.type] && (m[m.type].caption || m[m.type].filename)) || ''}`.trim();
    case 'location': return `[location] ${(m.location && m.location.name) || ''}`.trim();
    case 'reaction': return `[reaction] ${(m.reaction && m.reaction.emoji) || ''}`;
    default: return `[${m.type}]`;
  }
}
async function handleInbound(pn, m, contacts) {
  const waId = String(m.from); const ts = toDate(m.timestamp);
  const prof = contacts.find((c) => String(c.wa_id) === waId);
  const contact = await msgSvc.upsertContact(pn.tenant_id, waId, { name: prof && prof.profile && prof.profile.name, inboundAt: ts });
  try {
    await db.insert('messages', { tenant_id: pn.tenant_id, phone_row_id: pn.id, direction: 'in', wa_id: waId, wamid: String(m.id), msg_type: String(m.type || 'unknown').slice(0, 20), category: 'service', billable: 0, body_preview: String(previewOf(m) || '').slice(0, 500), payload: JSON.stringify(m).slice(0, 20000), status: 'received', source: 'meta', created_at: ts });
  } catch (e) { if (db.isUnique(e)) return; throw e; } // duplicate delivery
  await usage.bump(pn.tenant_id, 'service', 'inbound');
  if (m.type === 'text' && m.text && m.text.body) {
    const word = m.text.body.trim().toUpperCase();
    if (cfg.optOutWords.includes(word)) await db.update('contacts', { opted_out: 1, opted_out_at: new Date(), updated_at: new Date() }, 'id = ?', [contact.id]);
    else if (cfg.optInWords.includes(word) && contact.opted_out) await db.update('contacts', { opted_out: 0, opted_out_at: null, updated_at: new Date() }, 'id = ?', [contact.id]);
  }
  await outbound.emit(pn.tenant_id, 'message.received', { wamid: m.id, from: waId, name: prof && prof.profile && prof.profile.name, type: m.type, text: previewOf(m), timestamp: ts.toISOString(), message: m });
}

// ---- template / number / account fields ----
async function handleTemplate(wabaRow, field, v) {
  const name = v.message_template_name || v.template_name; const lang = v.message_template_language || v.template_language;
  const mid = v.message_template_id ? String(v.message_template_id) : null;
  let t = mid ? await db.one('SELECT * FROM message_templates WHERE waba_row_id = ? AND meta_template_id = ?', [wabaRow.id, mid]) : null;
  if (!t && name && lang) t = await db.one('SELECT * FROM message_templates WHERE waba_row_id = ? AND name = ? AND language = ?', [wabaRow.id, name, lang]);
  const f = { updated_at: new Date() };
  if (field === 'message_template_status_update') {
    const ev = String(v.event || '').toUpperCase(); f.status = ev === 'REINSTATED' ? 'APPROVED' : ev;
    f.rejected_reason = v.reason && v.reason !== 'NONE' ? String(v.reason).slice(0, 500) : null;
  } else if (field === 'message_template_quality_update') f.quality = String(v.new_quality_score || '').slice(0, 20) || null;
  else if (field === 'template_category_update') f.category = String(v.new_category || '').slice(0, 30) || null;
  if (t) await db.update('message_templates', f, 'id = ?', [t.id]);
  else if (name && lang) await tplSvc.upsertLocal(wabaRow.tenant_id, wabaRow.id, { id: mid, name, language: lang, status: f.status || 'PENDING', category: f.category, rejected_reason: f.rejected_reason });
  await outbound.emit(wabaRow.tenant_id, 'template.status', { name, language: lang, template_id: mid, event: v.event || field, status: f.status, reason: f.rejected_reason, new_category: v.new_category, quality: f.quality });
}
async function handleNumberUpdate(wabaRow, field, v) {
  const digits = String(v.display_phone_number || '').replace(/\D/g, '');
  const pn = digits ? (await db.query('SELECT * FROM phone_numbers WHERE waba_row_id = ?', [wabaRow.id])).find((p) => String(p.display_phone || '').replace(/\D/g, '') === digits) : null;
  if (!pn) return;
  const f = { updated_at: new Date() };
  if (field === 'phone_number_quality_update') { if (v.current_limit) f.messaging_tier = String(v.current_limit).slice(0, 30); }
  else if (field === 'phone_number_name_update') { f.name_status = String(v.decision || '').slice(0, 30) || null; if (v.decision === 'APPROVED' && v.requested_verified_name) f.verified_name = String(v.requested_verified_name).slice(0, 200); }
  await db.update('phone_numbers', f, 'id = ?', [pn.id]);
  if (field === 'phone_number_quality_update' && wabaRow.token_enc && wabaRow.token_valid) { // pull authoritative quality rating
    try { const p = await acct.getPhoneNumber(pn.phone_number_id, decrypt(wabaRow.token_enc)); await db.update('phone_numbers', { quality_rating: p.quality_rating || null, status: p.status || pn.status, messaging_tier: p.messaging_limit_tier || f.messaging_tier || pn.messaging_tier }, 'id = ?', [pn.id]); } catch { /* best effort */ }
  }
  await outbound.emit(wabaRow.tenant_id, 'number.quality', { phone_number_id: pn.phone_number_id, display_phone: pn.display_phone, event: v.event || v.decision || field, current_limit: v.current_limit, requested_verified_name: v.requested_verified_name });
}
async function handleAccount(wabaRow, field, v) {
  const f = { updated_at: new Date() };
  if (field === 'account_review_update') f.review_status = String(v.decision || '').slice(0, 30) || null;
  if (field === 'account_update') {
    const ev = String(v.event || '').toUpperCase();
    if (['ACCOUNT_DELETED', 'PARTNER_REMOVED', 'PARTNER_APP_UNINSTALLED'].includes(ev)) Object.assign(f, { status: 'disconnected', token_valid: 0, subscribed: 0, last_error: `Meta event: ${ev}` });
    else if (['DISABLED_UPDATE', 'ACCOUNT_VIOLATION', 'ACCOUNT_RESTRICTION'].includes(ev)) f.last_error = `Meta event: ${ev}`.slice(0, 500);
  }
  await db.update('waba_accounts', f, 'id = ?', [wabaRow.id]); tenantsSvc.invalidate(wabaRow.tenant_id);
  await outbound.emit(wabaRow.tenant_id, 'account.update', { waba_id: wabaRow.waba_id, field, event: v.event || v.decision, details: v });
}

async function handleChange(wabaId, change) {
  const field = change.field; const v = change.value || {};
  const wabaRow = wabaId ? await db.one('SELECT * FROM waba_accounts WHERE waba_id = ?', [String(wabaId)]) : null;
  await recordEvent(wabaRow && wabaRow.tenant_id, wabaId, field, v.event || v.decision, field === 'messages' ? { metadata: v.metadata, statuses: (v.statuses || []).length, messages: (v.messages || []).length } : v);
  if (field === 'messages') return handleMessages(wabaId, v);
  if (!wabaRow) return undefined;
  if (['message_template_status_update', 'message_template_quality_update', 'template_category_update'].includes(field)) return handleTemplate(wabaRow, field, v);
  if (['phone_number_quality_update', 'phone_number_name_update'].includes(field)) return handleNumberUpdate(wabaRow, field, v);
  if (['account_update', 'account_review_update'].includes(field)) return handleAccount(wabaRow, field, v);
  return undefined; // account_alerts, business_capability_update, smb_* ... are recorded in meta_events
}

async function processRow(id) {
  const row = await db.one('SELECT * FROM webhook_inbox WHERE id = ?', [id]);
  if (!row || row.state !== 'pending') return;
  const claimed = await db.update('webhook_inbox', { attempts: row.attempts + 1, processed_at: new Date() }, "id = ? AND state = 'pending' AND attempts = ?", [id, row.attempts]);
  if (!claimed) return; // another worker took it
  try {
    const p = JSON.parse(row.payload);
    if (p.object !== 'whatsapp_business_account') { await db.update('webhook_inbox', { state: 'skipped' }, 'id = ?', [id]); return; }
    let retry = null;
    for (const entry of p.entry || []) for (const ch of entry.changes || []) {
      try { await handleChange(entry.id, ch); } catch (e) { if (e instanceof RetryLater) retry = e; else throw e; }
    }
    if (retry) throw retry;
    await db.update('webhook_inbox', { state: 'done', last_error: null }, 'id = ?', [id]);
  } catch (e) {
    const final = !(e instanceof RetryLater) || row.attempts + 1 >= MAX_ATTEMPTS;
    if (final) log.error('webhook processing failed', e);
    await db.update('webhook_inbox', { state: final ? 'error' : 'pending', last_error: String(e.message).slice(0, 500) }, 'id = ?', [id]);
  }
}
// retry stragglers: rows not processed 20s after arrival, with growing delay per attempt
async function sweep(batch = 100) {
  const l = db.lim(batch);
  const rows = await db.query(`SELECT ${l.top} id, attempts, processed_at, received_at FROM webhook_inbox WHERE state = 'pending' AND received_at < ? ORDER BY id ${l.tail}`, [new Date(Date.now() - 15000)]);
  let n = 0;
  for (const r of rows) {
    const last = new Date(r.processed_at || r.received_at).getTime();
    if (Date.now() - last < Math.min(20000 * 2 ** r.attempts, 600000)) continue;
    await processRow(r.id); n++;
  }
  return n;
}
async function reprocess({ ids, state = 'error' } = {}) {
  if (ids && ids.length) { const clean = ids.map(Number).filter(Number.isInteger).slice(0, 200); if (!clean.length) return 0; return (await db.run(`UPDATE webhook_inbox SET state = 'pending', attempts = 0, last_error = NULL WHERE id IN (${clean.map(() => '?').join(',')})`, clean)).count; }
  return (await db.run("UPDATE webhook_inbox SET state = 'pending', attempts = 0, last_error = NULL WHERE state = ?", [state])).count;
}
module.exports = { receive, processRow, sweep, reprocess, RetryLater };
