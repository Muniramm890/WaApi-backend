'use strict';
const jwt = require('jsonwebtoken');
const cfg = require('../config');
const db = require('../db');
const { E } = require('../lib/errors');
const C = require('../lib/crypto');
const mailer = require('../lib/mailer');
const settings = require('./settings');
const tenantsSvc = require('./tenants');
const { audit } = require('./audit');

const ISS = 'wa-platform';
const LOCK_AFTER = 5; const LOCK_MIN = 15;
const addMs = (ms) => new Date(Date.now() + ms);
const portalBase = () => cfg.origins.portal[0] || cfg.publicBaseUrl || '';

const signAccess = (sub, aud, claims) => jwt.sign({ sub: String(sub), ...claims }, cfg.jwtSecret, { algorithm: 'HS256', audience: aud, issuer: ISS, expiresIn: cfg.accessTtlSec });
function verifyAccess(token, aud) {
  try { return jwt.verify(token, cfg.jwtSecret, { algorithms: ['HS256'], audience: aud, issuer: ISS }); }
  catch (e) { throw E.unauth(e.name === 'TokenExpiredError' ? 'Access token expired' : 'Invalid access token'); }
}

async function issueSession(type, user, req, familyId) {
  const refresh = C.randomToken(48);
  await db.insert('refresh_tokens', {
    subject_type: type, subject_id: user.id, token_hash: C.sha256(refresh), family_id: familyId || C.randomHex(16),
    expires_at: addMs(cfg.refreshTtlDays * 86400000), ip: req.ip ? String(req.ip).slice(0, 64) : null,
    user_agent: String(req.get('user-agent') || '').slice(0, 300), created_at: new Date(),
  });
  const aud = type === 'user' ? 'portal' : 'console';
  const claims = type === 'user' ? { tid: user.tenant_id, role: user.role } : { role: user.role };
  return { access_token: signAccess(user.id, aud, claims), refresh_token: refresh, token_type: 'Bearer', expires_in: cfg.accessTtlSec };
}
async function refresh(type, token, req) {
  const row = await db.one('SELECT * FROM refresh_tokens WHERE token_hash = ?', [C.sha256(String(token || ''))]);
  if (!row || row.subject_type !== type) throw E.unauth('Invalid refresh token');
  if (row.revoked_at) {
    if (Date.now() - new Date(row.revoked_at).getTime() < 10000) throw E.unauth('Refresh already used, retry with the new token'); // benign double-submit
    await db.update('refresh_tokens', { revoked_at: new Date() }, 'family_id = ? AND revoked_at IS NULL', [row.family_id]); // reuse => revoke family
    throw E.unauth('Refresh token reuse detected, please log in again');
  }
  if (new Date(row.expires_at) < new Date()) throw E.unauth('Session expired');
  const table = type === 'user' ? 'portal_users' : 'staff_users';
  const user = await db.one(`SELECT * FROM ${table} WHERE id = ?`, [row.subject_id]);
  if (!user || user.status !== 'active') throw E.unauth('Account disabled');
  await db.update('refresh_tokens', { revoked_at: new Date() }, 'id = ?', [row.id]);
  return { user, session: await issueSession(type, user, req, row.family_id) };
}
async function logout(type, token) {
  const row = await db.one('SELECT * FROM refresh_tokens WHERE token_hash = ?', [C.sha256(String(token || ''))]);
  if (row && row.subject_type === type) await db.update('refresh_tokens', { revoked_at: new Date() }, 'family_id = ? AND revoked_at IS NULL', [row.family_id]);
}
const revokeAll = (type, id) => db.update('refresh_tokens', { revoked_at: new Date() }, 'subject_type = ? AND subject_id = ? AND revoked_at IS NULL', [type, id]);

async function checkPassword(table, user, password, rawEmail) {
  if (!user) { await C.dummyVerify(password); throw E.unauth('Invalid email or password'); }
  if (user.locked_until && new Date(user.locked_until) > new Date()) throw E.tooMany('Too many failed attempts. Try again later.', LOCK_MIN * 60);
  if (!(await C.verifyPassword(String(password || ''), user.pw_hash))) {
    const n = user.failed_attempts + 1;
    await db.update(table, n >= LOCK_AFTER ? { failed_attempts: 0, locked_until: addMs(LOCK_MIN * 60000) } : { failed_attempts: n }, 'id = ?', [user.id]);
    throw E.unauth('Invalid email or password');
  }
}
const resetFails = (table, id) => db.update(table, { failed_attempts: 0, locked_until: null, last_login_at: new Date() }, 'id = ?', [id]);

async function loginPortal(email, password, req) {
  const user = await db.one('SELECT * FROM portal_users WHERE email = ?', [String(email || '').toLowerCase().trim()]);
  await checkPassword('portal_users', user, password);
  if (user.status !== 'active') throw E.forbidden('This user is disabled', 'USER_DISABLED');
  const t = await db.one('SELECT status FROM tenants WHERE id = ?', [user.tenant_id]);
  if (!t || t.status === 'deleted') throw E.forbidden('This account has been closed', 'TENANT_DELETED');
  await resetFails('portal_users', user.id);
  req.actor = { type: 'user', id: user.id, label: user.email };
  await audit(req, 'auth.login', { tenantId: user.tenant_id });
  return { user, session: await issueSession('user', user, req) };
}
async function loginStaff(email, password, totp, req) {
  const user = await db.one('SELECT * FROM staff_users WHERE email = ?', [String(email || '').toLowerCase().trim()]);
  await checkPassword('staff_users', user, password);
  if (user.status !== 'active') throw E.forbidden('This staff account is disabled', 'USER_DISABLED');
  if (user.totp_enabled) {
    if (!totp) { const e = E.unauth('Two-factor code required'); e.code = 'TOTP_REQUIRED'; throw e; }
    if (!C.totpVerify(C.decrypt(user.totp_secret_enc), totp)) throw E.unauth('Invalid two-factor code');
  }
  await resetFails('staff_users', user.id);
  req.actor = { type: 'staff', id: user.id, label: user.email };
  await audit(req, 'staff.login');
  return { user, session: await issueSession('staff', user, req) };
}

// ---- signup / verification / reset (portal) ----
async function signup({ business_name, name, email, password, phone, kind, country }, req) {
  if ((await settings.get('signup_open', '1')) !== '1') throw E.forbidden('Signups are currently closed', 'SIGNUP_CLOSED');
  if (await db.one('SELECT id FROM portal_users WHERE email = ?', [email])) throw E.conflict('An account with this email already exists', 'EMAIL_TAKEN');
  const free = await db.one("SELECT id FROM plans WHERE code = 'free'");
  const vtoken = C.randomToken(32); const now = new Date();
  const { tenantId, userId } = await db.tx(async (t) => {
    const tenantId = await t.insert('tenants', {
      name: business_name, kind: kind || 'business', status: cfg.autoApprove ? 'active' : 'pending', plan_id: free ? free.id : null,
      contact_email: email, contact_phone: phone || null, country: country || null, created_at: now, updated_at: now,
    });
    const userId = await t.insert('portal_users', {
      tenant_id: tenantId, email, name, pw_hash: await C.hashPassword(password), role: 'owner', status: 'active',
      verify_token_hash: C.sha256(vtoken), created_at: now, updated_at: now,
    });
    return { tenantId, userId };
  });
  await mailer.send({ to: email, subject: 'Verify your email', text: `Hi ${name},\n\nVerify your email: ${portalBase()}/verify-email?token=${vtoken}\n` });
  await audit(req, 'tenant.signup', { tenantId, actor: { type: 'user', id: userId, label: email }, targetType: 'tenant', targetId: tenantId });
  return { tenant_id: tenantId, user_id: userId, status: cfg.autoApprove ? 'active' : 'pending' };
}
async function verifyEmail(token) {
  const u = await db.one('SELECT id FROM portal_users WHERE verify_token_hash = ?', [C.sha256(String(token || ''))]);
  if (!u) throw E.bad('Invalid or already used verification link');
  await db.update('portal_users', { email_verified: 1, verify_token_hash: null, updated_at: new Date() }, 'id = ?', [u.id]);
}
async function forgotPassword(email) {
  const u = await db.one("SELECT * FROM portal_users WHERE email = ? AND status <> 'disabled'", [String(email || '').toLowerCase()]);
  if (!u) return; // never reveal whether the email exists
  const token = C.randomToken(32);
  await db.update('portal_users', { reset_token_hash: C.sha256(token), reset_expires: addMs(3600000) }, 'id = ?', [u.id]);
  await mailer.send({ to: u.email, subject: 'Reset your password', text: `Reset link (valid 1 hour): ${portalBase()}/reset-password?token=${token}\n` });
}
async function resetPassword(token, password) {
  const u = await db.one('SELECT * FROM portal_users WHERE reset_token_hash = ?', [C.sha256(String(token || ''))]);
  if (!u || !u.reset_expires || new Date(u.reset_expires) < new Date()) throw E.bad('Invalid or expired reset link');
  await db.update('portal_users', {
    pw_hash: await C.hashPassword(password), reset_token_hash: null, reset_expires: null, failed_attempts: 0, locked_until: null,
    status: u.status === 'invited' ? 'active' : u.status, email_verified: 1, updated_at: new Date(),
  }, 'id = ?', [u.id]);
  await revokeAll('user', u.id);
}
async function changePassword(type, user, current, next) {
  const table = type === 'user' ? 'portal_users' : 'staff_users';
  if (!(await C.verifyPassword(String(current || ''), user.pw_hash))) throw E.forbidden('Current password is incorrect', 'BAD_PASSWORD');
  await db.update(table, { pw_hash: await C.hashPassword(next), updated_at: new Date() }, 'id = ?', [user.id]);
  await revokeAll(type, user.id);
}
async function inviteUser(tenantId, { email, name, role }) {
  if (await db.one('SELECT id FROM portal_users WHERE email = ?', [email])) throw E.conflict('This email is already registered', 'EMAIL_TAKEN');
  const token = C.randomToken(32); const now = new Date();
  const id = await db.insert('portal_users', {
    tenant_id: tenantId, email, name, pw_hash: await C.hashPassword(C.randomToken(24)), role, status: 'invited',
    reset_token_hash: C.sha256(token), reset_expires: addMs(7 * 86400000), created_at: now, updated_at: now,
  });
  await mailer.send({ to: email, subject: 'You have been invited', text: `Set your password: ${portalBase()}/reset-password?token=${token}\n` });
  return id;
}
async function createTenantWithOwner({ business_name, name, email, kind, plan_id, status = 'active' }) {
  if (await db.one('SELECT id FROM portal_users WHERE email = ?', [email])) throw E.conflict('This email is already registered', 'EMAIL_TAKEN');
  const now = new Date(); const token = C.randomToken(32);
  const out = await db.tx(async (t) => {
    const tenantId = await t.insert('tenants', { name: business_name, kind: kind || 'business', status, plan_id: plan_id || null, contact_email: email, created_at: now, updated_at: now });
    const userId = await t.insert('portal_users', { tenant_id: tenantId, email, name, pw_hash: await C.hashPassword(C.randomToken(24)), role: 'owner', status: 'invited', reset_token_hash: C.sha256(token), reset_expires: addMs(7 * 86400000), created_at: now, updated_at: now });
    return { tenantId, userId };
  });
  await mailer.send({ to: email, subject: 'Your account is ready', text: `Set your password: ${portalBase()}/reset-password?token=${token}\n` });
  return out;
}
const publicUser = (u) => ({ id: u.id, tenant_id: u.tenant_id, email: u.email, name: u.name, role: u.role, status: u.status, email_verified: !!u.email_verified, last_login_at: u.last_login_at, created_at: u.created_at });
const publicStaff = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, totp_enabled: !!u.totp_enabled, last_login_at: u.last_login_at, created_at: u.created_at });

module.exports = {
  verifyAccess, issueSession, refresh, logout, revokeAll, loginPortal, loginStaff, signup, verifyEmail, forgotPassword,
  resetPassword, changePassword, inviteUser, createTenantWithOwner, publicUser, publicStaff, tenantsSvc,
};
