'use strict';
// Control Center API: /api/console  (JWT audience "console"; staff only)
const express = require('express');
const db = require('../db');
const { E, wrap } = require('../lib/errors');
const v = require('../lib/validate');
const C = require('../lib/crypto');
const { fixedWindow } = require('../lib/ratelimit');
const cfg = require('../config');
const { consoleAuth, staffRole } = require('../middleware/auth');
const authSvc = require('../services/auth');
const tenantsSvc = require('../services/tenants');
const wabas = require('../services/wabas');
const billing = require('../services/billing');
const usage = require('../services/usage');
const settings = require('../services/settings');
const hook = require('../services/metaWebhook');
const outbound = require('../services/outbound');
const jobs = require('../services/jobs');
const { audit } = require('../services/audit');

const r = express.Router();
const SUPPORT = staffRole('support'); const FINANCE = staffRole('finance'); const ADMIN = staffRole(); // super_admin only
const reqBefore = (q) => v.cursor(q.before);

// ---------- auth ----------
r.post('/auth/login', fixedWindow({ windowMs: 600e3, max: 20, message: 'Too many login attempts' }), wrap(async (req, res) => {
  const { user, session } = await authSvc.loginStaff(req.body && req.body.email, req.body && req.body.password, req.body && req.body.totp, req);
  res.json({ ...session, user: authSvc.publicStaff(user) });
}));
r.post('/auth/refresh', wrap(async (req, res) => { const { user, session } = await authSvc.refresh('staff', req.body && req.body.refresh_token, req); res.json({ ...session, user: authSvc.publicStaff(user) }); }));
r.post('/auth/logout', wrap(async (req, res) => { await authSvc.logout('staff', req.body && req.body.refresh_token); res.status(204).end(); }));

r.use(consoleAuth);
r.get('/me', (req, res) => res.json({ user: authSvc.publicStaff(req.staff) }));
r.post('/me/password', wrap(async (req, res) => { await authSvc.changePassword('staff', req.staff, req.body && req.body.current_password, v.password(req.body, 'new_password')); await audit(req, 'staff.password_change'); res.status(204).end(); }));
r.post('/me/totp/setup', wrap(async (req, res) => {
  if (req.staff.totp_enabled) throw E.conflict('Two-factor is already enabled', 'TOTP_ENABLED');
  const secret = C.newTotpSecret();
  await db.update('staff_users', { totp_secret_enc: C.encrypt(secret), updated_at: new Date() }, 'id = ?', [req.staff.id]);
  res.json({ secret, otpauth_uri: C.totpUri(secret, req.staff.email) });
}));
r.post('/me/totp/enable', wrap(async (req, res) => {
  if (!req.staff.totp_secret_enc) throw E.bad('Run /me/totp/setup first');
  if (!C.totpVerify(C.decrypt(req.staff.totp_secret_enc), req.body && req.body.code)) throw E.bad('Invalid code');
  await db.update('staff_users', { totp_enabled: 1, updated_at: new Date() }, 'id = ?', [req.staff.id]); await audit(req, 'staff.totp_enable'); res.json({ ok: true });
}));
r.post('/me/totp/disable', wrap(async (req, res) => {
  if (!(await C.verifyPassword(String(req.body && req.body.password || ''), req.staff.pw_hash))) throw E.forbidden('Password is incorrect', 'BAD_PASSWORD');
  await db.update('staff_users', { totp_enabled: 0, totp_secret_enc: null, updated_at: new Date() }, 'id = ?', [req.staff.id]); await audit(req, 'staff.totp_disable'); res.json({ ok: true });
}));

// ---------- dashboard ----------
r.get('/stats', wrap(async (req, res) => {
  const d1 = new Date(Date.now() - 86400000); const ms = usage.monthStart(); const l = db.lim(5);
  const [tenants, out24, failed24, in24, inbox, deliveries, lowQ, tokens, top, outstanding] = await Promise.all([
    db.query('SELECT status, COUNT(*) AS n FROM tenants GROUP BY status'),
    db.one("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out' AND created_at >= ?", [d1]),
    db.one("SELECT COUNT(*) AS n FROM messages WHERE direction = 'out' AND status = 'failed' AND created_at >= ?", [d1]),
    db.one("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in' AND created_at >= ?", [d1]),
    db.query('SELECT state, COUNT(*) AS n FROM webhook_inbox GROUP BY state'),
    db.query('SELECT state, COUNT(*) AS n FROM webhook_deliveries GROUP BY state'),
    db.one("SELECT COUNT(*) AS n FROM phone_numbers WHERE quality_rating IN ('RED','YELLOW')"),
    db.one("SELECT COUNT(*) AS n FROM waba_accounts WHERE status = 'active' AND token_valid = 0"),
    db.query(`SELECT ${l.top} tenant_id, SUM(sent) AS n FROM usage_daily WHERE day >= ? GROUP BY tenant_id ORDER BY n DESC ${l.tail}`, [ms]),
    db.one("SELECT COUNT(*) AS n, SUM(total_paise - paid_paise) AS due FROM invoices WHERE status IN ('issued','overdue')"),
  ]);
  const map = (rows) => Object.fromEntries(rows.map((x) => [x.state || x.status, Number(x.n)]));
  res.json({ tenants: map(tenants), messages_24h: { out: Number(out24.n), failed: Number(failed24.n), in: Number(in24.n) }, webhook_inbox: map(inbox), webhook_deliveries: map(deliveries), numbers_low_quality: Number(lowQ.n), wabas_invalid_token: Number(tokens.n), top_tenants_this_month: top, invoices_outstanding: { count: Number(outstanding.n), due_paise: Number(outstanding.due || 0) }, jobs: jobs.names });
}));

// ---------- tenants ----------
r.get('/tenants', wrap(async (req, res) => {
  const w = ['1 = 1']; const p = [];
  if (req.query.status) { w.push('status = ?'); p.push(req.query.status); }
  if (req.query.q) { w.push('(LOWER(name) LIKE ? OR LOWER(contact_email) LIKE ?)'); const q = `%${String(req.query.q).toLowerCase()}%`; p.push(q, q); }
  const b = reqBefore(req.query); if (b) { w.push('id < ?'); p.push(b); }
  const l = db.lim(v.limit(req.query.limit));
  const rows = await db.query(`SELECT ${l.top} * FROM tenants WHERE ${w.join(' AND ')} ORDER BY id DESC ${l.tail}`, p);
  res.json({ data: rows.map(tenantsSvc.publicTenant), next_before: rows.length ? rows[rows.length - 1].id : null });
}));
r.post('/tenants', SUPPORT, wrap(async (req, res) => {
  const b = req.body || {};
  const out = await authSvc.createTenantWithOwner({ business_name: v.str(b, 'business_name', { required: true, max: 200 }), name: v.str(b, 'owner_name', { required: true, max: 200 }), email: v.email(b, 'owner_email'), kind: v.oneOf(b, 'kind', ['school', 'business', 'reseller', 'other']), plan_id: v.int(b, 'plan_id', { min: 1 }) });
  await audit(req, 'tenant.create', { tenantId: out.tenantId, targetType: 'tenant', targetId: out.tenantId }); res.status(201).json({ tenant_id: out.tenantId, owner_id: out.userId });
}));
r.get('/tenants/:id', wrap(async (req, res) => {
  const id = v.id(req.params.id); const t = await db.one('SELECT * FROM tenants WHERE id = ?', [id]); if (!t) throw E.notFound('Tenant');
  const c = await tenantsSvc.getCtx(id); const one = async (sql) => Number((await db.one(sql, [id])).n);
  res.json({ tenant: tenantsSvc.publicTenant(t), plan: tenantsSvc.publicPlan(c.plan), overview: await billing.overview(c),
    counts: { users: await one('SELECT COUNT(*) AS n FROM portal_users WHERE tenant_id = ?'), api_keys: await one("SELECT COUNT(*) AS n FROM api_keys WHERE tenant_id = ? AND status = 'active'"), wabas: await one("SELECT COUNT(*) AS n FROM waba_accounts WHERE tenant_id = ? AND status = 'active'"), numbers: await one('SELECT COUNT(*) AS n FROM phone_numbers WHERE tenant_id = ?'), templates: await one("SELECT COUNT(*) AS n FROM message_templates WHERE tenant_id = ? AND status = 'APPROVED'"), unpaid_invoices: await one("SELECT COUNT(*) AS n FROM invoices WHERE tenant_id = ? AND status IN ('issued','overdue')") } });
}));
r.patch('/tenants/:id', SUPPORT, wrap(async (req, res) => {
  const id = v.id(req.params.id); const b = req.body || {}; const f = { updated_at: new Date() };
  for (const [k, max] of [['name', 200], ['contact_email', 200], ['contact_phone', 30], ['website', 200], ['gstin', 20], ['address', 500], ['timezone', 60], ['country', 2], ['external_ref', 100]]) { const x = v.str(b, k, { max }); if (x !== undefined) f[k] = x; }
  const kind = v.oneOf(b, 'kind', ['school', 'business', 'reseller', 'other']); if (kind) f.kind = kind;
  try { if (!(await db.update('tenants', f, 'id = ?', [id]))) throw E.notFound('Tenant'); } catch (e) { if (db.isUnique(e)) throw E.conflict('external_ref already used by another tenant'); throw e; }
  tenantsSvc.invalidate(id); await audit(req, 'tenant.update', { tenantId: id }); res.json({ ok: true });
}));
const setStatus = (status, action, needReason) => wrap(async (req, res) => {
  const id = v.id(req.params.id); const t = await db.one('SELECT * FROM tenants WHERE id = ?', [id]); if (!t) throw E.notFound('Tenant');
  if (t.status === 'deleted') throw E.conflict('Tenant is deleted', 'TENANT_DELETED');
  const reason = needReason ? v.str(req.body, 'reason', { required: true, max: 300 }) : null;
  await db.update('tenants', { status, suspended_reason: reason, updated_at: new Date() }, 'id = ?', [id]); tenantsSvc.invalidate(id);
  await audit(req, action, { tenantId: id, meta: { reason } }); res.json({ ok: true, status });
});
r.post('/tenants/:id/approve', SUPPORT, setStatus('active', 'tenant.approve'));
r.post('/tenants/:id/activate', SUPPORT, setStatus('active', 'tenant.activate'));
r.post('/tenants/:id/suspend', SUPPORT, setStatus('suspended', 'tenant.suspend', true));
r.delete('/tenants/:id', ADMIN, wrap(async (req, res) => {
  const id = v.id(req.params.id); const ws = await db.query("SELECT id FROM waba_accounts WHERE tenant_id = ? AND status = 'active'", [id]);
  for (const w of ws) { try { await wabas.disconnect(id, w.id, req.actor); } catch { /* continue */ } }
  await db.update('api_keys', { status: 'revoked', revoked_at: new Date() }, "tenant_id = ? AND status = 'active'", [id]);
  await db.update('portal_users', { status: 'disabled', updated_at: new Date() }, 'tenant_id = ?', [id]);
  await db.update('tenants', { status: 'deleted', deleted_at: new Date(), updated_at: new Date() }, 'id = ?', [id]); tenantsSvc.invalidate(id);
  await audit(req, 'tenant.delete', { tenantId: id }); res.status(204).end();
}));
r.post('/tenants/:id/plan', SUPPORT, wrap(async (req, res) => {
  const id = v.id(req.params.id); const planId = v.int(req.body, 'plan_id', { required: true, min: 1 });
  if (!(await db.one('SELECT id FROM plans WHERE id = ?', [planId]))) throw E.notFound('Plan');
  await db.update('tenants', { plan_id: planId, updated_at: new Date() }, 'id = ?', [id]); tenantsSvc.invalidate(id);
  await audit(req, 'tenant.plan_change', { tenantId: id, meta: { plan_id: planId } }); res.json({ ok: true });
}));
r.get('/tenants/:id/usage', wrap(async (req, res) => res.json(await usage.summary(v.id(req.params.id), v.isoDay(req.query.from, 'from') || usage.monthStart(), v.isoDay(req.query.to, 'to') || usage.dayStr()))));
r.get('/tenants/:id/users', wrap(async (req, res) => res.json({ data: (await db.query('SELECT * FROM portal_users WHERE tenant_id = ? ORDER BY id', [v.id(req.params.id)])).map(authSvc.publicUser) })));
r.get('/tenants/:id/api-keys', wrap(async (req, res) => res.json({ data: await require('../services/apikeys').list(v.id(req.params.id)) })));
r.post('/tenants/:id/api-keys/:kid/revoke', SUPPORT, wrap(async (req, res) => { await require('../services/apikeys').revoke(v.id(req.params.id), v.id(req.params.kid)); await audit(req, 'apikey.revoke', { tenantId: Number(req.params.id), targetType: 'api_key', targetId: req.params.kid }); res.status(204).end(); }));
r.get('/tenants/:id/wabas', wrap(async (req, res) => res.json({ data: await wabas.listForTenant(v.id(req.params.id)) })));
r.post('/tenants/:id/wabas/attach', SUPPORT, wrap(async (req, res) => {
  const id = v.id(req.params.id); const c = await tenantsSvc.getCtx(id); if (!c) throw E.notFound('Tenant');
  const token = v.str(req.body, 'access_token', { max: 1000 }) || cfg.meta.systemToken; if (!token) throw E.bad('Provide "access_token" or configure META_SYSTEM_USER_TOKEN');
  res.status(201).json(await wabas.attachWaba({ ...c, actor: req.actor }, v.str(req.body, 'waba_id', { required: true, max: 30 }), token, { tokenType: req.body.access_token ? 'business' : 'system' }));
}));
r.post('/wabas/:id/sync', SUPPORT, wrap(async (req, res) => res.json(await wabas.sync(null, v.id(req.params.id)))));
r.post('/wabas/:id/disconnect', SUPPORT, wrap(async (req, res) => { await wabas.disconnect(null, v.id(req.params.id), req.actor); res.status(204).end(); }));
r.get('/tenants/:id/messages', wrap(async (req, res) => res.json(await require('../services/messagesSvc').list(v.id(req.params.id), { status: req.query.status, direction: req.query.direction, before: reqBefore(req.query), limit: v.limit(req.query.limit) }))));

// ---------- plans ----------
const planFields = (b, partial) => {
  const f = {}; const ints = [['price_paise', 0], ['included_msgs', 0], ['fee_per_msg_paise', 0], ['monthly_msg_cap', 0], ['max_numbers', 0], ['max_api_keys', 0], ['max_webhooks', 0], ['rate_per_sec', 1]];
  const name = v.str(b, 'name', { required: !partial, max: 120 }); if (name) f.name = name;
  const desc = v.str(b, 'description', { max: 400 }); if (desc !== undefined) f.description = desc;
  for (const [k, min] of ints) { const x = v.int(b, k, { min, max: 2000000000 }); if (x !== undefined) f[k] = x; }
  for (const k of ['is_public', 'is_active']) { const x = v.bool(b, k); if (x !== undefined) f[k] = x ? 1 : 0; }
  return f;
};
r.get('/plans', wrap(async (req, res) => res.json({ data: await db.query('SELECT * FROM plans ORDER BY price_paise') })));
r.post('/plans', ADMIN, wrap(async (req, res) => {
  const code = v.str(req.body, 'code', { required: true, max: 40 }); if (!/^[a-z0-9_-]+$/.test(code)) throw E.bad('"code" must be lowercase letters, numbers, - or _');
  const now = new Date();
  try { const id = await db.insert('plans', { ...planFields(req.body, false), code, created_at: now, updated_at: now }); await audit(req, 'plan.create', { targetType: 'plan', targetId: id }); res.status(201).json({ id }); }
  catch (e) { if (db.isUnique(e)) throw E.conflict('Plan code already exists'); throw e; }
}));
r.patch('/plans/:id', ADMIN, wrap(async (req, res) => {
  const id = v.id(req.params.id); const f = planFields(req.body, true); f.updated_at = new Date();
  if (!(await db.update('plans', f, 'id = ?', [id]))) throw E.notFound('Plan');
  tenantsSvc.invalidate(); await audit(req, 'plan.update', { targetType: 'plan', targetId: id }); res.json({ ok: true });
}));
r.get('/plan-requests', wrap(async (req, res) => res.json({ data: await db.query('SELECT * FROM plan_requests WHERE status = ? ORDER BY id DESC', [req.query.status || 'pending']) })));
const decide = (approve) => wrap(async (req, res) => {
  const id = v.id(req.params.id); const pr = await db.one("SELECT * FROM plan_requests WHERE id = ? AND status = 'pending'", [id]); if (!pr) throw E.notFound('Pending request');
  if (approve) { await db.update('tenants', { plan_id: pr.plan_id, updated_at: new Date() }, 'id = ?', [pr.tenant_id]); tenantsSvc.invalidate(pr.tenant_id); }
  await db.update('plan_requests', { status: approve ? 'approved' : 'rejected', decided_by: req.staff.id, decided_at: new Date() }, 'id = ?', [id]);
  await audit(req, approve ? 'plan.request_approve' : 'plan.request_reject', { tenantId: pr.tenant_id }); res.json({ ok: true });
});
r.post('/plan-requests/:id/approve', SUPPORT, decide(true)); r.post('/plan-requests/:id/reject', SUPPORT, decide(false));

// ---------- billing ----------
r.get('/invoices', FINANCE, wrap(async (req, res) => res.json({ data: await billing.listInvoices({ tenantId: req.query.tenant_id ? v.id(req.query.tenant_id) : undefined, status: req.query.status, before: reqBefore(req.query), limit: v.limit(req.query.limit) }) })));
r.get('/invoices/:id', FINANCE, wrap(async (req, res) => res.json(await billing.getInvoice(v.id(req.params.id)))));
r.post('/invoices/run', FINANCE, wrap(async (req, res) => { const out = await billing.generateInvoices(v.str(req.body, 'period', { max: 7 })); await audit(req, 'invoice.run', { meta: out }); res.json(out); }));
r.post('/invoices/enforce', FINANCE, wrap(async (req, res) => res.json(await billing.enforceDues())));
r.post('/invoices/:id/payments', FINANCE, wrap(async (req, res) => res.status(201).json(await billing.recordPayment(v.id(req.params.id), { amount_paise: req.body && req.body.amount_paise, method: v.str(req.body, 'method', { max: 30 }), reference: v.str(req.body, 'reference', { max: 100 }), note: v.str(req.body, 'note', { max: 300 }) }, req.actor))));
r.post('/invoices/:id/void', FINANCE, wrap(async (req, res) => { await billing.voidInvoice(v.id(req.params.id), v.str(req.body, 'reason', { required: true, max: 300 }), req.actor); res.json({ ok: true }); }));

// ---------- platform health & logs ----------
r.get('/numbers', wrap(async (req, res) => {
  const w = ['1 = 1']; const p = []; if (req.query.quality) { w.push('quality_rating = ?'); p.push(String(req.query.quality).toUpperCase()); } if (req.query.status) { w.push('status = ?'); p.push(req.query.status); }
  const l = db.lim(v.limit(req.query.limit, 100, 500));
  res.json({ data: await db.query(`SELECT ${l.top} p.id, p.tenant_id, p.phone_number_id, p.display_phone, p.verified_name, p.quality_rating, p.messaging_tier, p.status, p.name_status, p.registered, p.register_error FROM phone_numbers p WHERE ${w.join(' AND ')} ORDER BY p.id DESC ${l.tail}`, p) });
}));
r.get('/wabas', wrap(async (req, res) => {
  const w = ['1 = 1']; if (req.query.token_valid === '0') w.push('token_valid = 0'); if (req.query.status) w.push("status = '" + (req.query.status === 'disconnected' ? 'disconnected' : 'active') + "'");
  const l = db.lim(v.limit(req.query.limit, 100, 500));
  res.json({ data: (await db.query(`SELECT ${l.top} * FROM waba_accounts WHERE ${w.join(' AND ')} ORDER BY id DESC ${l.tail}`)).map(wabas.shapeWaba) });
}));
r.get('/messages', wrap(async (req, res) => {
  const w = ['1 = 1']; const p = []; const add = (c, x) => { w.push(c); p.push(x); };
  if (req.query.tenant_id) add('tenant_id = ?', v.id(req.query.tenant_id)); if (req.query.status) add('status = ?', req.query.status); if (req.query.direction) add('direction = ?', req.query.direction === 'in' ? 'in' : 'out'); if (req.query.error_code) add('error_code = ?', req.query.error_code);
  const b = reqBefore(req.query); if (b) add('id < ?', b); const l = db.lim(v.limit(req.query.limit));
  const rows = await db.query(`SELECT ${l.top} * FROM messages WHERE ${w.join(' AND ')} ORDER BY id DESC ${l.tail}`, p);
  res.json({ data: rows.map(require('../services/messagesSvc').shape), next_before: rows.length ? rows[rows.length - 1].id : null });
}));
r.get('/webhook-inbox', wrap(async (req, res) => {
  const l = db.lim(v.limit(req.query.limit)); const b = reqBefore(req.query);
  res.json({ data: await db.query(`SELECT ${l.top} id, received_at, signature_ok, state, attempts, last_error, processed_at FROM webhook_inbox WHERE state = ?${b ? ' AND id < ?' : ''} ORDER BY id DESC ${l.tail}`, b ? [req.query.state || 'error', b] : [req.query.state || 'error']) });
}));
r.get('/webhook-inbox/:id', wrap(async (req, res) => { const row = await db.one('SELECT * FROM webhook_inbox WHERE id = ?', [v.id(req.params.id)]); if (!row) throw E.notFound('Inbox row'); res.json({ ...row, payload: JSON.parse(row.payload) }); }));
r.post('/webhook-inbox/reprocess', SUPPORT, wrap(async (req, res) => { const n = await hook.reprocess({ ids: req.body && req.body.ids, state: (req.body && req.body.state) || 'error' }); await audit(req, 'webhook_inbox.reprocess', { meta: { n } }); res.json({ requeued: n }); }));
r.get('/meta-events', wrap(async (req, res) => {
  const w = ['1 = 1']; const p = []; if (req.query.tenant_id) { w.push('tenant_id = ?'); p.push(v.id(req.query.tenant_id)); } if (req.query.field) { w.push('field = ?'); p.push(req.query.field); }
  const b = reqBefore(req.query); if (b) { w.push('id < ?'); p.push(b); } const l = db.lim(v.limit(req.query.limit));
  res.json({ data: await db.query(`SELECT ${l.top} id, tenant_id, waba_id, field, event, created_at FROM meta_events WHERE ${w.join(' AND ')} ORDER BY id DESC ${l.tail}`, p) });
}));
r.get('/deliveries', wrap(async (req, res) => {
  const l = db.lim(v.limit(req.query.limit)); const b = reqBefore(req.query);
  res.json({ data: await db.query(`SELECT ${l.top} id, tenant_id, endpoint_id, event_type, state, attempts, last_status, last_error, created_at FROM webhook_deliveries WHERE state = ?${b ? ' AND id < ?' : ''} ORDER BY id DESC ${l.tail}`, b ? [req.query.state || 'failed', b] : [req.query.state || 'failed']) });
}));
r.get('/audit', wrap(async (req, res) => {
  const w = ['1 = 1']; const p = []; if (req.query.tenant_id) { w.push('tenant_id = ?'); p.push(v.id(req.query.tenant_id)); } if (req.query.action) { w.push('action = ?'); p.push(req.query.action); }
  const b = reqBefore(req.query); if (b) { w.push('id < ?'); p.push(b); } const l = db.lim(v.limit(req.query.limit));
  res.json({ data: await db.query(`SELECT ${l.top} * FROM audit_logs WHERE ${w.join(' AND ')} ORDER BY id DESC ${l.tail}`, p) });
}));

// ---------- settings, staff, jobs ----------
const SETTING_KEYS = ['tax_percent', 'grace_days', 'invoice_due_days', 'invoice_prefix', 'signup_open'];
r.get('/settings', wrap(async (req, res) => { const a = await settings.all(); res.json(Object.fromEntries(SETTING_KEYS.map((k) => [k, a[k]]))); }));
r.put('/settings', ADMIN, wrap(async (req, res) => {
  for (const [k, val] of Object.entries(req.body || {})) { if (!SETTING_KEYS.includes(k)) throw E.bad(`Unknown setting "${k}"`); await settings.set(k, String(val).slice(0, 100)); }
  await audit(req, 'settings.update', { meta: req.body }); res.json({ ok: true });
}));
r.get('/staff', ADMIN, wrap(async (req, res) => res.json({ data: (await db.query('SELECT * FROM staff_users ORDER BY id')).map(authSvc.publicStaff) })));
r.post('/staff', ADMIN, wrap(async (req, res) => {
  const b = req.body || {}; const email = v.email(b, 'email'); const now = new Date();
  try { const id = await db.insert('staff_users', { email, name: v.str(b, 'name', { required: true, max: 200 }), pw_hash: await C.hashPassword(v.password(b)), role: v.oneOf(b, 'role', ['super_admin', 'support', 'finance'], { required: true }), status: 'active', created_at: now, updated_at: now }); await audit(req, 'staff.create', { targetType: 'staff', targetId: id }); res.status(201).json({ id }); }
  catch (e) { if (db.isUnique(e)) throw E.conflict('A staff user with this email exists', 'EMAIL_TAKEN'); throw e; }
}));
r.patch('/staff/:id', ADMIN, wrap(async (req, res) => {
  const id = v.id(req.params.id); const f = { updated_at: new Date() }; const b = req.body || {};
  const role = v.oneOf(b, 'role', ['super_admin', 'support', 'finance']); if (role) f.role = role; const st = v.oneOf(b, 'status', ['active', 'disabled']); if (st) f.status = st; const nm = v.str(b, 'name', { max: 200 }); if (nm) f.name = nm;
  if (id === req.staff.id && (f.status === 'disabled' || (f.role && f.role !== 'super_admin'))) throw E.forbidden('You cannot demote or disable yourself', 'PROTECTED_USER');
  if (!(await db.update('staff_users', f, 'id = ?', [id]))) throw E.notFound('Staff user');
  if (st === 'disabled') await authSvc.revokeAll('staff', id); await audit(req, 'staff.update', { targetType: 'staff', targetId: id }); res.json({ ok: true });
}));
r.post('/staff/:id/reset-password', ADMIN, wrap(async (req, res) => {
  const id = v.id(req.params.id); if (!(await db.update('staff_users', { pw_hash: await C.hashPassword(v.password(req.body)), failed_attempts: 0, locked_until: null, updated_at: new Date() }, 'id = ?', [id]))) throw E.notFound('Staff user');
  await authSvc.revokeAll('staff', id); await audit(req, 'staff.password_reset', { targetType: 'staff', targetId: id }); res.json({ ok: true });
}));
r.post('/jobs/:name/run', ADMIN, wrap(async (req, res) => { if (!jobs.names.includes(req.params.name)) throw E.notFound('Job'); res.json(await jobs.run(req.params.name)); }));
module.exports = r;
