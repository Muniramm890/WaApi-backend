'use strict';
const db = require('../db');
const { E } = require('../lib/errors');
const T = require('../meta/templates');
const wabas = require('./wabas');
const { audit } = require('./audit');
const { MetaError } = require('../meta/graph');

const shape = (t) => ({
  id: t.id, waba_row_id: t.waba_row_id, meta_template_id: t.meta_template_id, name: t.name, language: t.language, category: t.category,
  status: t.status, quality: t.quality, components: t.components ? JSON.parse(t.components) : [], rejected_reason: t.rejected_reason,
  created_at: t.created_at, updated_at: t.updated_at,
});
async function upsertLocal(tenantId, wabaRowId, m) {
  const now = new Date();
  const f = {
    meta_template_id: m.id ? String(m.id) : null, category: m.category || null, status: String(m.status || 'PENDING').toUpperCase(),
    quality: (m.quality_score && m.quality_score.score) || null, components: m.components ? JSON.stringify(m.components) : null,
    rejected_reason: m.rejected_reason && m.rejected_reason !== 'NONE' ? String(m.rejected_reason).slice(0, 500) : null, last_synced_at: now, updated_at: now,
  };
  const ex = await db.one('SELECT id FROM message_templates WHERE waba_row_id = ? AND name = ? AND language = ?', [wabaRowId, m.name, m.language]);
  if (ex) { await db.update('message_templates', f, 'id = ?', [ex.id]); return ex.id; }
  try { return await db.insert('message_templates', { ...f, tenant_id: tenantId, waba_row_id: wabaRowId, name: m.name, language: m.language, created_at: now }); }
  catch (e) { if (db.isUnique(e)) return null; throw e; }
}
async function syncWaba(tenantId, w) {
  const token = wabas.tokenOf(w);
  let list;
  try { list = await T.list(w.waba_id, token); } catch (e) { if (e instanceof MetaError && e.isAuth) await wabas.markTokenInvalid(w.id, e.message); throw wabas.metaErr(e); }
  const seen = new Set();
  for (const m of list) { await upsertLocal(tenantId, w.id, m); seen.add(`${m.name}|${m.language}`); }
  const local = await db.query("SELECT id, name, language FROM message_templates WHERE waba_row_id = ? AND status <> 'DELETED'", [w.id]);
  for (const l of local) if (!seen.has(`${l.name}|${l.language}`)) await db.update('message_templates', { status: 'DELETED', updated_at: new Date() }, 'id = ?', [l.id]);
  return list.length;
}
async function sync(tenantId) {
  const ws = await db.query("SELECT * FROM waba_accounts WHERE tenant_id = ? AND status = 'active' AND token_valid = 1", [tenantId]);
  let total = 0; for (const w of ws) total += await syncWaba(tenantId, w);
  return { synced: total };
}
async function list(tenantId, { status, category, name, wabaRowId, limit = 100, before } = {}) {
  const where = ['tenant_id = ?']; const p = [tenantId];
  if (status) { where.push('status = ?'); p.push(String(status).toUpperCase()); }
  if (category) { where.push('category = ?'); p.push(String(category).toUpperCase()); }
  if (name) { where.push('LOWER(name) LIKE ?'); p.push(`%${String(name).toLowerCase()}%`); }
  if (wabaRowId) { where.push('waba_row_id = ?'); p.push(wabaRowId); }
  if (before) { where.push('id < ?'); p.push(before); }
  const l = db.lim(limit);
  return (await db.query(`SELECT ${l.top} * FROM message_templates WHERE ${where.join(' AND ')} ORDER BY id DESC ${l.tail}`, p)).map(shape);
}
async function get(tenantId, id) {
  const t = await db.one('SELECT * FROM message_templates WHERE id = ? AND tenant_id = ?', [id, tenantId]);
  if (!t) throw E.notFound('Template');
  return shape(t);
}
async function create(ctx, input) {
  const body = T.validate(input);
  let w;
  if (input.waba_row_id) w = await wabas.getWabaRow(ctx.tenant.id, Number(input.waba_row_id));
  else {
    const ws = await db.query("SELECT * FROM waba_accounts WHERE tenant_id = ? AND status = 'active' ORDER BY id", [ctx.tenant.id]);
    if (!ws.length) throw E.unprocessable('NO_WABA', 'Connect a WhatsApp account first');
    if (ws.length > 1) throw E.bad('Multiple WhatsApp accounts connected: pass "waba_row_id"');
    w = ws[0];
  }
  let r;
  try { r = await T.create(w.waba_id, wabas.tokenOf(w), body); } catch (e) { if (e instanceof MetaError && e.isAuth) await wabas.markTokenInvalid(w.id, e.message); throw wabas.metaErr(e, 422); }
  const id = await upsertLocal(ctx.tenant.id, w.id, { id: r.id, name: body.name, language: body.language, category: r.category || body.category, status: r.status || 'PENDING', components: body.components });
  await audit(null, 'template.create', { tenantId: ctx.tenant.id, actor: ctx.actor, targetType: 'template', targetId: body.name });
  return get(ctx.tenant.id, id);
}
async function remove(ctx, id) {
  const t = await db.one('SELECT * FROM message_templates WHERE id = ? AND tenant_id = ?', [id, ctx.tenant.id]);
  if (!t) throw E.notFound('Template');
  const w = await db.one('SELECT * FROM waba_accounts WHERE id = ?', [t.waba_row_id]);
  try { await T.remove(w.waba_id, wabas.tokenOf(w), t.name, t.meta_template_id || undefined); }
  catch (e) { if (!(e instanceof MetaError) || ![100, 132001].includes(e.code)) throw wabas.metaErr(e, 422); } // already gone on Meta => fine
  await db.update('message_templates', { status: 'DELETED', updated_at: new Date() }, 'id = ?', [t.id]);
  await audit(null, 'template.delete', { tenantId: ctx.tenant.id, actor: ctx.actor, targetType: 'template', targetId: t.name });
}
async function findApproved(tenantId, wabaRowId, name, language) {
  return db.one('SELECT * FROM message_templates WHERE tenant_id = ? AND waba_row_id = ? AND name = ? AND language = ?', [tenantId, wabaRowId, name, language]);
}
module.exports = { sync, syncWaba, list, get, create, remove, upsertLocal, findApproved, shape };
