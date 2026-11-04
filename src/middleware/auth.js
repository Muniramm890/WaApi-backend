'use strict';
const crypto = require('crypto');
const db = require('../db');
const log = require('../lib/logger');
const { E, wrap } = require('../lib/errors');
const { take } = require('../lib/ratelimit');
const authSvc = require('../services/auth');
const apikeys = require('../services/apikeys');
const tenantsSvc = require('../services/tenants');

const bearer = (req) => { const h = req.get('authorization') || ''; return /^Bearer /i.test(h) ? h.slice(7).trim() : null; };

function requestContext(req, res, next) {
  req.id = req.get('x-request-id') || crypto.randomUUID(); res.setHeader('X-Request-Id', req.id);
  const t0 = Date.now();
  res.on('finish', () => { if (req.path !== '/healthz') log.info('req', { id: req.id, m: req.method, p: req.path, s: res.statusCode, ms: Date.now() - t0, tenant: req.ctx && req.ctx.tenant && req.ctx.tenant.id }); });
  next();
}

// ---- Public API (API key) ----
const apiKeyAuth = wrap(async (req, res, next) => {
  const raw = bearer(req) || req.get('x-api-key');
  const key = await apikeys.authenticate(raw, req.ip);
  const c = await tenantsSvc.getCtx(key.tenant_id);
  if (!c || c.tenant.status === 'deleted') throw E.unauth('Account closed');
  const rate = key.rate_per_sec || c.plan.rate_per_sec || 10;
  const rl = take('key:' + key.id, rate);
  if (!rl.ok) throw E.tooMany(`Rate limit of ${rate} requests/second exceeded`, rl.retryAfter);
  req.apiKey = key; req.ctx = { tenant: c.tenant, plan: c.plan, apiKeyId: key.id, source: 'api', actor: { type: 'api_key', id: key.id, label: `key:${key.prefix}` } };
  req.actor = req.ctx.actor; req.scopes = new Set(key.scopes.split(','));
  next();
});
const apiGuard = (scope) => (req, res, next) => (req.scopes && req.scopes.has(scope) ? next() : next(E.forbidden(`This API key lacks the "${scope}" scope`, 'INSUFFICIENT_SCOPE')));

// ---- Portal (JWT, aud=portal) ----
const ROLE_RANK = { viewer: 1, developer: 2, admin: 3, owner: 4 };
const SCOPE_ROLE = { 'messages:send': 'developer', 'messages:read': 'viewer', 'templates:read': 'viewer', 'templates:write': 'developer', 'media:read': 'viewer', 'media:write': 'developer', 'contacts:read': 'viewer', 'contacts:write': 'developer', 'numbers:read': 'viewer', 'webhooks:manage': 'admin', 'usage:read': 'viewer' };
const portalAuth = wrap(async (req, res, next) => {
  const tok = bearer(req); if (!tok) throw E.unauth();
  const claims = authSvc.verifyAccess(tok, 'portal');
  const user = await db.one('SELECT * FROM portal_users WHERE id = ?', [Number(claims.sub)]);
  if (!user || user.status !== 'active') throw E.unauth('Account disabled');
  const c = await tenantsSvc.getCtx(user.tenant_id);
  if (!c || c.tenant.status === 'deleted') throw E.unauth('Account closed');
  req.user = user; req.actor = { type: 'user', id: user.id, label: user.email };
  req.ctx = { tenant: c.tenant, plan: c.plan, source: 'portal', actor: req.actor };
  next();
});
const portalRole = (min) => (req, res, next) => (ROLE_RANK[req.user.role] >= ROLE_RANK[min] ? next() : next(E.forbidden(`Requires ${min} role or higher`, 'INSUFFICIENT_ROLE')));
const portalGuard = (scope) => portalRole(SCOPE_ROLE[scope] || 'admin');

// ---- Console (JWT, aud=console) ----
const consoleAuth = wrap(async (req, res, next) => {
  const tok = bearer(req); if (!tok) throw E.unauth();
  const claims = authSvc.verifyAccess(tok, 'console');
  const staff = await db.one('SELECT * FROM staff_users WHERE id = ?', [Number(claims.sub)]);
  if (!staff || staff.status !== 'active') throw E.unauth('Account disabled');
  req.staff = staff; req.actor = { type: 'staff', id: staff.id, label: staff.email };
  next();
});
const staffRole = (...roles) => (req, res, next) => (req.staff.role === 'super_admin' || roles.includes(req.staff.role) ? next() : next(E.forbidden('Your staff role cannot do this', 'INSUFFICIENT_ROLE')));

// block Meta-touching writes for non-active tenants
const operational = (req, res, next) => { try { tenantsSvc.assertOperational(req.ctx.tenant); next(); } catch (e) { next(e); } };

module.exports = { requestContext, apiKeyAuth, apiGuard, portalAuth, portalRole, portalGuard, consoleAuth, staffRole, operational, ROLE_RANK };
