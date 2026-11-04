'use strict';
// Customer Portal API: /api/portal  (JWT audience "portal")
const express = require('express');
const db = require('../db');
const { E, wrap } = require('../lib/errors');
const v = require('../lib/validate');
const { fixedWindow } = require('../lib/ratelimit');
const { portalAuth, portalRole, portalGuard, ROLE_RANK } = require('../middleware/auth');
const authSvc = require('../services/auth');
const apikeys = require('../services/apikeys');
const wabas = require('../services/wabas');
const billing = require('../services/billing');
const tenantsSvc = require('../services/tenants');
const { audit } = require('../services/audit');
const tenantApi = require('./tenantApi');

const r = express.Router();
const lim = (windowMs, max, message) => fixedWindow({ windowMs, max, message });

// ---------- public auth endpoints ----------
r.post('/auth/signup', lim(3600e3, 10, 'Too many signups from this address'), wrap(async (req, res) => {
  const b = req.body || {};
  const out = await authSvc.signup({
    business_name: v.str(b, 'business_name', { required: true, min: 2, max: 200 }), name: v.str(b, 'name', { required: true, min: 2, max: 200 }),
    email: v.email(b, 'email'), password: v.password(b), phone: v.str(b, 'phone', { max: 30 }), country: v.str(b, 'country', { max: 2 }),
    kind: v.oneOf(b, 'kind', ['school', 'business', 'reseller', 'other']),
  }, req);
  res.status(201).json(out);
}));
r.post('/auth/login', lim(600e3, 30, 'Too many login attempts'), wrap(async (req, res) => {
  const { user, session } = await authSvc.loginPortal(req.body && req.body.email, req.body && req.body.password, req);
  res.json({ ...session, user: authSvc.publicUser(user) });
}));
r.post('/auth/refresh', lim(600e3, 60), wrap(async (req, res) => {
  const { user, session } = await authSvc.refresh('user', req.body && req.body.refresh_token, req);
  res.json({ ...session, user: authSvc.publicUser(user) });
}));
r.post('/auth/logout', wrap(async (req, res) => { await authSvc.logout('user', req.body && req.body.refresh_token); res.status(204).end(); }));
r.post('/auth/verify-email', lim(3600e3, 30), wrap(async (req, res) => { await authSvc.verifyEmail(req.body && req.body.token); res.json({ ok: true }); }));
r.post('/auth/forgot-password', lim(3600e3, 8), wrap(async (req, res) => { await authSvc.forgotPassword(req.body && req.body.email); res.json({ ok: true }); }));
r.post('/auth/reset-password', lim(3600e3, 20), wrap(async (req, res) => { await authSvc.resetPassword(req.body && req.body.token, v.password(req.body)); res.json({ ok: true }); }));
r.get('/plans', wrap(async (req, res) => res.json({ data: (await db.query('SELECT * FROM plans WHERE is_public = 1 AND is_active = 1 ORDER BY price_paise')).map(tenantsSvc.publicPlan) })));

// ---------- authenticated ----------
r.use(portalAuth);
r.get('/me', wrap(async (req, res) => res.json({ user: authSvc.publicUser(req.user), tenant: tenantsSvc.publicTenant(req.ctx.tenant), plan: tenantsSvc.publicPlan(req.ctx.plan) })));
r.post('/me/password', wrap(async (req, res) => { await authSvc.changePassword('user', req.user, req.body && req.body.current_password, v.password(req.body, 'new_password')); await audit(req, 'user.password_change'); res.status(204).end(); }));
r.patch('/me', wrap(async (req, res) => { const name = v.str(req.body, 'name', { min: 2, max: 200 }); if (name) await db.update('portal_users', { name, updated_at: new Date() }, 'id = ?', [req.user.id]); res.json({ ok: true }); }));

r.get('/account', wrap(async (req, res) => res.json(tenantsSvc.publicTenant(req.ctx.tenant))));
r.patch('/account', portalRole('admin'), wrap(async (req, res) => {
  const b = req.body || {}; const f = { updated_at: new Date() };
  for (const [k, max] of [['name', 200], ['contact_phone', 30], ['website', 200], ['gstin', 20], ['address', 500], ['timezone', 60], ['country', 2]]) { const x = v.str(b, k, { max }); if (x !== undefined) f[k] = x; }
  await db.update('tenants', f, 'id = ?', [req.ctx.tenant.id]); tenantsSvc.invalidate(req.ctx.tenant.id);
  await audit(req, 'tenant.update'); res.json({ ok: true });
}));

// ---------- plan & billing ----------
r.get('/plan', wrap(async (req, res) => res.json(await billing.overview(req.ctx))));
r.post('/plan-requests', portalRole('admin'), wrap(async (req, res) => {
  const planId = v.int(req.body, 'plan_id', { required: true, min: 1 });
  const plan = await db.one('SELECT id FROM plans WHERE id = ? AND is_active = 1 AND is_public = 1', [planId]); if (!plan) throw E.notFound('Plan');
  const id = await db.insert('plan_requests', { tenant_id: req.ctx.tenant.id, plan_id: planId, note: v.str(req.body, 'note', { max: 400 }) || null, status: 'pending', requested_by: req.user.id, created_at: new Date() });
  await audit(req, 'plan.request', { targetType: 'plan', targetId: planId }); res.status(201).json({ id, status: 'pending' });
}));
r.get('/invoices', portalRole('admin'), wrap(async (req, res) => res.json({ data: await billing.listInvoices({ tenantId: req.ctx.tenant.id, status: req.query.status, before: v.cursor(req.query.before), limit: v.limit(req.query.limit) }) })));
r.get('/invoices/:id', portalRole('admin'), wrap(async (req, res) => res.json(await billing.getInvoice(v.id(req.params.id), req.ctx.tenant.id))));

// ---------- team ----------
r.get('/team', portalRole('admin'), wrap(async (req, res) => res.json({ data: (await db.query('SELECT * FROM portal_users WHERE tenant_id = ? ORDER BY id', [req.ctx.tenant.id])).map(authSvc.publicUser) })));
r.post('/team', portalRole('admin'), wrap(async (req, res) => {
  const role = v.oneOf(req.body, 'role', ['viewer', 'developer', 'admin'], { required: true });
  if (ROLE_RANK[role] > ROLE_RANK[req.user.role]) throw E.forbidden('You cannot grant a role higher than your own', 'INSUFFICIENT_ROLE');
  const id = await authSvc.inviteUser(req.ctx.tenant.id, { email: v.email(req.body, 'email'), name: v.str(req.body, 'name', { required: true, max: 200 }), role });
  await audit(req, 'team.invite', { targetType: 'user', targetId: id }); res.status(201).json({ id });
}));
r.patch('/team/:id', portalRole('admin'), wrap(async (req, res) => {
  const id = v.id(req.params.id); const u = await db.one('SELECT * FROM portal_users WHERE id = ? AND tenant_id = ?', [id, req.ctx.tenant.id]);
  if (!u) throw E.notFound('User');
  if (u.role === 'owner' || u.id === req.user.id) throw E.forbidden('This user cannot be modified here', 'PROTECTED_USER');
  if (ROLE_RANK[u.role] >= ROLE_RANK[req.user.role] && req.user.role !== 'owner') throw E.forbidden('You cannot modify a user with an equal or higher role', 'INSUFFICIENT_ROLE');
  const f = { updated_at: new Date() };
  const role = v.oneOf(req.body, 'role', ['viewer', 'developer', 'admin']); if (role) { if (ROLE_RANK[role] > ROLE_RANK[req.user.role]) throw E.forbidden('Role too high', 'INSUFFICIENT_ROLE'); f.role = role; }
  const status = v.oneOf(req.body, 'status', ['active', 'disabled']); if (status) f.status = status;
  await db.update('portal_users', f, 'id = ?', [id]); if (status === 'disabled') await authSvc.revokeAll('user', id);
  await audit(req, 'team.update', { targetType: 'user', targetId: id, meta: { role, status } }); res.json({ ok: true });
}));

// ---------- API keys ----------
r.get('/api-keys', portalRole('admin'), wrap(async (req, res) => res.json({ data: await apikeys.list(req.ctx.tenant.id), available_scopes: apikeys.SCOPES })));
r.post('/api-keys', portalRole('admin'), wrap(async (req, res) => {
  tenantsSvc.assertOperational(req.ctx.tenant);
  const b = req.body || {};
  const out = await apikeys.create(req.ctx.tenant.id, req.ctx.plan, { name: v.str(b, 'name', { required: true, max: 100 }), scopes: Array.isArray(b.scopes) ? b.scopes : undefined, ip_allowlist: v.str(b, 'ip_allowlist', { max: 500 }), expires_at: b.expires_at, rate_per_sec: v.int(b, 'rate_per_sec', { min: 1, max: 1000 }) }, req.user.id);
  await audit(req, 'apikey.create', { targetType: 'api_key', targetId: out.id }); res.status(201).json(out);
}));
r.delete('/api-keys/:id', portalRole('admin'), wrap(async (req, res) => { await apikeys.revoke(req.ctx.tenant.id, v.id(req.params.id)); await audit(req, 'apikey.revoke', { targetType: 'api_key', targetId: req.params.id }); res.status(204).end(); }));

// ---------- WhatsApp onboarding (Embedded Signup) ----------
const wa = express.Router();
wa.get('/signup-config', portalRole('admin'), wrap(async (req, res) => { tenantsSvc.assertOperational(req.ctx.tenant); res.json(wabas.signupConfig(req.ctx)); }));
wa.post('/signup/complete', portalRole('admin'), wrap(async (req, res) => {
  tenantsSvc.assertOperational(req.ctx.tenant);
  const b = req.body || {};
  res.status(201).json({ data: await wabas.completeEmbeddedSignup(req.ctx, { code: v.str(b, 'code', { required: true, max: 2000 }), waba_id: v.str(b, 'waba_id', { max: 30 }), business_id: v.str(b, 'business_id', { max: 30 }), phone_number_id: v.str(b, 'phone_number_id', { max: 30 }), state: v.str(b, 'state', { required: true, max: 2000 }) }) });
}));
wa.get('/accounts', wrap(async (req, res) => res.json({ data: await wabas.listForTenant(req.ctx.tenant.id) })));
wa.post('/accounts/:id/sync', portalRole('developer'), wrap(async (req, res) => res.json(await wabas.sync(req.ctx.tenant.id, v.id(req.params.id)))));
wa.delete('/accounts/:id', portalRole('admin'), wrap(async (req, res) => { await wabas.disconnect(req.ctx.tenant.id, v.id(req.params.id), req.actor); res.status(204).end(); }));
wa.post('/numbers/:id/default', portalRole('admin'), wrap(async (req, res) => { await wabas.setDefault(req.ctx.tenant.id, v.id(req.params.id)); res.json({ ok: true }); }));
wa.patch('/numbers/:id', portalRole('admin'), wrap(async (req, res) => { await wabas.setLabel(req.ctx.tenant.id, v.id(req.params.id), v.str(req.body, 'label', { max: 100 })); res.json({ ok: true }); }));
wa.get('/numbers/:id/profile', wrap(async (req, res) => res.json(await wabas.profile(req.ctx.tenant.id, v.id(req.params.id)))));
wa.put('/numbers/:id/profile', portalRole('admin'), wrap(async (req, res) => { await wabas.updateProfile(req.ctx.tenant.id, v.id(req.params.id), req.body || {}); res.json({ ok: true }); }));
wa.post('/numbers/:id/register', portalRole('admin'), wrap(async (req, res) => { await wabas.registerNumber(req.ctx.tenant.id, v.id(req.params.id), req.body && req.body.pin); res.json({ ok: true }); }));
wa.post('/numbers/:id/request-code', portalRole('admin'), wrap(async (req, res) => { await wabas.requestCode(req.ctx.tenant.id, v.id(req.params.id), req.body && req.body.method); res.json({ ok: true }); }));
wa.post('/numbers/:id/verify-code', portalRole('admin'), wrap(async (req, res) => { await wabas.verifyCode(req.ctx.tenant.id, v.id(req.params.id), v.str(req.body, 'code', { required: true, max: 10 })); res.json({ ok: true }); }));
r.use('/whatsapp', wa);

r.get('/audit', portalRole('admin'), wrap(async (req, res) => {
  const before = v.cursor(req.query.before); const l = db.lim(v.limit(req.query.limit));
  res.json({ data: await db.query(`SELECT ${l.top} id, actor_type, actor_label, action, target_type, target_id, ip, created_at FROM audit_logs WHERE tenant_id = ?${before ? ' AND id < ?' : ''} ORDER BY id DESC ${l.tail}`, before ? [req.ctx.tenant.id, before] : [req.ctx.tenant.id]) });
}));

// messages, templates, media, contacts, webhooks, usage, numbers (shared with the public API)
r.use('/', tenantApi(portalGuard));
module.exports = r;
