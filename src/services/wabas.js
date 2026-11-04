'use strict';
// WABA / phone number lifecycle: Embedded Signup completion, attach, sync, disconnect, profile, registration.
const crypto = require('crypto');
const cfg = require('../config');
const db = require('../db');
const log = require('../lib/logger');
const { E } = require('../lib/errors');
const { encrypt, decrypt, verifyState, signState } = require('../lib/crypto');
const { MetaError } = require('../meta/graph');
const acct = require('../meta/account');
const tenantsSvc = require('./tenants');
const { audit } = require('./audit');

const metaErr = (e, fallbackStatus = 400) => (e instanceof MetaError
  ? Object.assign(E.unprocessable('META_ERROR', e.message, { meta_code: e.code, meta_subcode: e.subcode, fbtrace_id: e.fbtraceId }), { status: e.isRateLimit ? 429 : e.httpStatus >= 500 ? 502 : fallbackStatus })
  : e);

function signupConfig(ctx) {
  if (!cfg.meta.appId || !cfg.meta.esConfigId) throw E.conflict('Embedded Signup is not configured on this platform yet', 'ES_NOT_CONFIGURED');
  return {
    app_id: cfg.meta.appId, config_id: cfg.meta.esConfigId, api_version: cfg.meta.apiVersion,
    state: signState({ tid: ctx.tenant.id, uid: ctx.actor.id, n: crypto.randomBytes(6).toString('hex') }),
    // the frontend runs FB.login({config_id, response_type:'code', override_default_response_type:true, extras:{setup:{}, featureType:'', sessionInfoVersion:'3'}})
  };
}

async function completeEmbeddedSignup(ctx, { code, waba_id, business_id, phone_number_id, state }) {
  const st = verifyState(state);
  if (!st || st.tid !== ctx.tenant.id) throw E.bad('Invalid or expired signup session. Please start again.');
  if (!code) throw E.bad('"code" is required');
  let token; let dbg;
  try { token = (await acct.exchangeCode(code)).token; dbg = await acct.debugToken(token); }
  catch (e) { throw metaErr(e); }
  if (!dbg.valid) throw E.bad('Meta rejected the signup token');
  const wabaIds = waba_id ? [String(waba_id)] : dbg.wabaIds;
  if (!wabaIds.length) throw E.bad('No WhatsApp Business Account was shared during signup');
  if (waba_id && dbg.wabaIds.length && !dbg.wabaIds.includes(String(waba_id))) throw E.forbidden('This token was not granted access to that WhatsApp Business Account', 'WABA_NOT_GRANTED');
  const out = [];
  for (const id of wabaIds) out.push(await attachWaba(ctx, id, token, { fbUserId: dbg.userId, businessId: business_id, preferredPhoneId: phone_number_id, tokenType: 'business' }));
  return out;
}

// Attach a WABA given a valid access token (used by Embedded Signup and by staff "attach existing").
async function attachWaba(ctx, wabaId, token, { fbUserId, businessId, preferredPhoneId, tokenType = 'business' } = {}) {
  const { tenant, plan } = ctx;
  if (!/^\d{5,25}$/.test(String(wabaId))) throw E.bad('Invalid WABA id');
  const existing = await db.one('SELECT * FROM waba_accounts WHERE waba_id = ?', [wabaId]);
  if (existing && existing.tenant_id !== tenant.id) throw E.conflict('This WhatsApp Business Account is already connected to another account', 'WABA_IN_USE');
  let info; let phones;
  try { info = await acct.getWaba(wabaId, token); phones = await acct.listPhoneNumbers(wabaId, token); } catch (e) { throw metaErr(e); }

  const known = existing ? await db.query('SELECT phone_number_id FROM phone_numbers WHERE waba_row_id = ?', [existing.id]) : [];
  const knownIds = new Set(known.map((k) => k.phone_number_id));
  const fresh = phones.filter((p) => !knownIds.has(p.id)).length;
  if (fresh) await tenantsSvc.assertWithinLimit(plan, tenant.id, 'numbers', fresh);

  const now = new Date();
  const base = {
    business_id: businessId || (info.on_behalf_of_business_info && info.on_behalf_of_business_info.id) || (existing && existing.business_id) || null,
    name: info.name || null, currency: info.currency || null, timezone_id: info.timezone_id || null,
    review_status: info.account_review_status || null, business_verification: info.business_verification_status || null,
    template_namespace: info.message_template_namespace || null, status: 'active', token_enc: encrypt(token), token_type: tokenType,
    token_valid: 1, token_checked_at: now, fb_user_id: fbUserId || (existing && existing.fb_user_id) || null, last_error: null, last_synced_at: now, updated_at: now,
  };
  let wabaRowId;
  if (existing) { wabaRowId = existing.id; await db.update('waba_accounts', base, 'id = ?', [wabaRowId]); }
  else wabaRowId = await db.insert('waba_accounts', { ...base, tenant_id: tenant.id, waba_id: String(wabaId), subscribed: 0, created_at: now });

  // Route this WABA's webhooks to our app
  try { await acct.subscribeApp(wabaId, token); await db.update('waba_accounts', { subscribed: 1 }, 'id = ?', [wabaRowId]); }
  catch (e) { await db.update('waba_accounts', { subscribed: 0, last_error: `subscribe failed: ${e.message}`.slice(0, 500) }, 'id = ?', [wabaRowId]); log.warn('subscribeApp failed', { wabaId, msg: e.message }); }

  const hasDefault = await db.one('SELECT id FROM phone_numbers WHERE tenant_id = ? AND is_default = 1', [tenant.id]);
  let first = !hasDefault;
  for (const p of phones) {
    const fields = phoneFields(p);
    const row = await db.one('SELECT id FROM phone_numbers WHERE phone_number_id = ?', [p.id]);
    if (row) { await db.update('phone_numbers', { ...fields, last_synced_at: now, updated_at: now }, 'id = ?', [row.id]); continue; }
    const isDef = first || (preferredPhoneId && String(preferredPhoneId) === p.id) ? 1 : 0;
    if (isDef) { await db.update('phone_numbers', { is_default: 0 }, 'tenant_id = ?', [tenant.id]); first = false; }
    const id = await db.insert('phone_numbers', { ...fields, tenant_id: tenant.id, waba_row_id: wabaRowId, phone_number_id: p.id, registered: 0, is_default: isDef, last_synced_at: now, created_at: now, updated_at: now });
    await ensureRegistered(id, p, token);
  }
  tenantsSvc.invalidate(tenant.id);
  await audit(null, existing ? 'waba.reattach' : 'waba.attach', { tenantId: tenant.id, actor: ctx.actor, targetType: 'waba', targetId: wabaId });
  return summarize(wabaRowId);
}

const phoneFields = (p) => ({
  display_phone: p.display_phone_number || null, verified_name: p.verified_name || null, quality_rating: p.quality_rating || null,
  messaging_tier: p.messaging_limit_tier || null, name_status: p.name_status || null, status: p.status || null,
  platform_type: p.platform_type || null, throughput_level: (p.throughput && p.throughput.level) || null,
});

// Newly added numbers that are not yet on Cloud API need /register with a 6-digit PIN.
async function ensureRegistered(phoneRowId, p, token, pin) {
  const needs = p.platform_type !== 'CLOUD_API' || ['PENDING', 'DISCONNECTED', 'UNKNOWN'].includes(String(p.status || '').toUpperCase());
  if (!needs) { await db.update('phone_numbers', { registered: 1, register_error: null }, 'id = ?', [phoneRowId]); return; }
  const usePin = pin || String(crypto.randomInt(100000, 1000000));
  try {
    await acct.registerPhone(p.id, token, usePin);
    await db.update('phone_numbers', { registered: 1, pin_enc: encrypt(usePin), register_error: null, updated_at: new Date() }, 'id = ?', [phoneRowId]);
  } catch (e) {
    await db.update('phone_numbers', { registered: 0, register_error: String(e.message).slice(0, 300), updated_at: new Date() }, 'id = ?', [phoneRowId]);
  }
}

async function summarize(wabaRowId) {
  const w = await db.one('SELECT * FROM waba_accounts WHERE id = ?', [wabaRowId]);
  const numbers = await db.query('SELECT * FROM phone_numbers WHERE waba_row_id = ? ORDER BY id', [wabaRowId]);
  return { ...shapeWaba(w), numbers: numbers.map(shapeNumber) };
}
const shapeWaba = (w) => ({
  id: w.id, waba_id: w.waba_id, business_id: w.business_id, name: w.name, currency: w.currency, review_status: w.review_status,
  business_verification: w.business_verification, status: w.status, token_valid: !!w.token_valid, subscribed: !!w.subscribed,
  last_error: w.last_error, last_synced_at: w.last_synced_at, created_at: w.created_at, tenant_id: w.tenant_id,
});
const shapeNumber = (p) => ({
  id: p.id, phone_number_id: p.phone_number_id, display_phone: p.display_phone, verified_name: p.verified_name, label: p.label,
  quality_rating: p.quality_rating, messaging_tier: p.messaging_tier, name_status: p.name_status, status: p.status,
  platform_type: p.platform_type, registered: !!p.registered, register_error: p.register_error, is_default: !!p.is_default, waba_row_id: p.waba_row_id,
});
async function listForTenant(tenantId) {
  const wabas = await db.query('SELECT * FROM waba_accounts WHERE tenant_id = ? ORDER BY id', [tenantId]);
  const nums = await db.query('SELECT * FROM phone_numbers WHERE tenant_id = ? ORDER BY id', [tenantId]);
  return wabas.map((w) => ({ ...shapeWaba(w), numbers: nums.filter((n) => n.waba_row_id === w.id).map(shapeNumber) }));
}

async function getWabaRow(tenantId, id) {
  const w = await db.one('SELECT * FROM waba_accounts WHERE id = ?' + (tenantId ? ' AND tenant_id = ?' : ''), tenantId ? [id, tenantId] : [id]);
  if (!w) throw E.notFound('WhatsApp account');
  return w;
}
function tokenOf(w) {
  if (w.status !== 'active') throw E.conflict('This WhatsApp account is disconnected', 'WABA_DISCONNECTED');
  if (!w.token_valid || !w.token_enc) throw E.conflict('The WhatsApp access token is no longer valid. Reconnect the account.', 'WABA_TOKEN_INVALID');
  return decrypt(w.token_enc);
}
async function markTokenInvalid(wabaRowId, msg) {
  await db.update('waba_accounts', { token_valid: 0, last_error: String(msg || 'token invalid').slice(0, 500), updated_at: new Date() }, 'id = ?', [wabaRowId]);
}

async function sync(tenantId, wabaRowId) {
  const w = await getWabaRow(tenantId, wabaRowId);
  const token = tokenOf(w); const now = new Date();
  try {
    const info = await acct.getWaba(w.waba_id, token);
    const phones = await acct.listPhoneNumbers(w.waba_id, token);
    await db.update('waba_accounts', { name: info.name || w.name, currency: info.currency || w.currency, review_status: info.account_review_status || null, business_verification: info.business_verification_status || null, template_namespace: info.message_template_namespace || null, token_valid: 1, token_checked_at: now, last_error: null, last_synced_at: now, updated_at: now }, 'id = ?', [w.id]);
    for (const p of phones) {
      const row = await db.one('SELECT id FROM phone_numbers WHERE phone_number_id = ?', [p.id]);
      if (row) await db.update('phone_numbers', { ...phoneFields(p), last_synced_at: now, updated_at: now }, 'id = ?', [row.id]);
    }
  } catch (e) {
    if (e instanceof MetaError && e.isAuth) await markTokenInvalid(w.id, e.message);
    throw metaErr(e);
  }
  return summarize(w.id);
}

async function disconnect(tenantId, wabaRowId, actor) {
  const w = await getWabaRow(tenantId, wabaRowId);
  if (w.status === 'active' && w.token_enc && w.token_valid) { try { await acct.unsubscribeApp(w.waba_id, decrypt(w.token_enc)); } catch (e) { log.warn('unsubscribe failed', { msg: e.message }); } }
  await db.update('waba_accounts', { status: 'disconnected', token_enc: null, token_valid: 0, subscribed: 0, updated_at: new Date() }, 'id = ?', [w.id]);
  await db.update('phone_numbers', { is_default: 0, status: 'DISCONNECTED', updated_at: new Date() }, 'waba_row_id = ?', [w.id]);
  tenantsSvc.invalidate(w.tenant_id);
  await audit(null, 'waba.disconnect', { tenantId: w.tenant_id, actor, targetType: 'waba', targetId: w.waba_id });
}

async function resolveSender(tenantId, ref) {
  let p;
  if (ref !== undefined && ref !== null && ref !== '') {
    const s = String(ref);
    p = await db.one('SELECT * FROM phone_numbers WHERE tenant_id = ? AND (phone_number_id = ? OR id = ?)', [tenantId, s, /^\d{1,15}$/.test(s) ? Number(s) : -1]);
    if (!p) throw E.unprocessable('SENDER_NOT_FOUND', 'The "from" phone number does not belong to your account');
  } else {
    p = await db.one("SELECT * FROM phone_numbers WHERE tenant_id = ? AND is_default = 1 AND status <> 'DISCONNECTED'", [tenantId])
      || await db.one("SELECT * FROM phone_numbers WHERE tenant_id = ? AND status <> 'DISCONNECTED' ORDER BY id", [tenantId]);
    if (!p) throw E.unprocessable('NO_NUMBER', 'No WhatsApp number is connected. Connect one from the portal first.');
  }
  const w = await db.one('SELECT * FROM waba_accounts WHERE id = ?', [p.waba_row_id]);
  return { phone: p, waba: w };
}
async function setDefault(tenantId, phoneRowId) {
  const p = await db.one('SELECT id FROM phone_numbers WHERE id = ? AND tenant_id = ?', [phoneRowId, tenantId]);
  if (!p) throw E.notFound('Phone number');
  await db.tx(async (t) => { await t.update('phone_numbers', { is_default: 0 }, 'tenant_id = ?', [tenantId]); await t.update('phone_numbers', { is_default: 1 }, 'id = ?', [phoneRowId]); });
}
async function numberWithToken(tenantId, phoneRowId) {
  const p = await db.one('SELECT * FROM phone_numbers WHERE id = ?' + (tenantId ? ' AND tenant_id = ?' : ''), tenantId ? [phoneRowId, tenantId] : [phoneRowId]);
  if (!p) throw E.notFound('Phone number');
  const w = await db.one('SELECT * FROM waba_accounts WHERE id = ?', [p.waba_row_id]);
  return { p, w, token: tokenOf(w) };
}
async function registerNumber(tenantId, phoneRowId, pin) {
  if (!/^\d{6}$/.test(String(pin || ''))) throw E.bad('"pin" must be 6 digits');
  const { p, token } = await numberWithToken(tenantId, phoneRowId);
  try { await acct.registerPhone(p.phone_number_id, token, String(pin)); } catch (e) { throw metaErr(e); }
  await db.update('phone_numbers', { registered: 1, pin_enc: encrypt(String(pin)), register_error: null, updated_at: new Date() }, 'id = ?', [p.id]);
}
const profile = async (tenantId, id) => { const { p, token } = await numberWithToken(tenantId, id); try { const r = await acct.getProfile(p.phone_number_id, token); return (r.data && r.data[0]) || r; } catch (e) { throw metaErr(e); } };
async function updateProfile(tenantId, id, body) {
  const { p, token } = await numberWithToken(tenantId, id);
  const allowed = {}; for (const k of ['about', 'address', 'description', 'email', 'vertical', 'websites', 'profile_picture_handle']) if (body[k] !== undefined) allowed[k] = body[k];
  if (!Object.keys(allowed).length) throw E.bad('Nothing to update');
  try { await acct.updateProfile(p.phone_number_id, token, allowed); } catch (e) { throw metaErr(e); }
}
async function requestCode(tenantId, id, method) { const { p, token } = await numberWithToken(tenantId, id); try { await acct.requestCode(p.phone_number_id, token, method === 'VOICE' ? 'VOICE' : 'SMS'); } catch (e) { throw metaErr(e); } }
async function verifyCode(tenantId, id, code) { const { p, token } = await numberWithToken(tenantId, id); try { await acct.verifyCode(p.phone_number_id, token, String(code)); } catch (e) { throw metaErr(e); } await db.update('phone_numbers', { updated_at: new Date() }, 'id = ?', [p.id]); }
async function setLabel(tenantId, id, label) { const n = await db.update('phone_numbers', { label: label || null, updated_at: new Date() }, 'id = ? AND tenant_id = ?', [id, tenantId]); if (!n) throw E.notFound('Phone number'); }

// Periodic token health: returns number of WABAs checked.
async function healthCheckAll() {
  const rows = await db.query("SELECT * FROM waba_accounts WHERE status = 'active' AND token_valid = 1 AND token_enc IS NOT NULL");
  let n = 0;
  for (const w of rows) {
    try { const d = await acct.debugToken(decrypt(w.token_enc)); n++; await db.update('waba_accounts', { token_valid: d.valid ? 1 : 0, token_checked_at: new Date(), last_error: d.valid ? null : 'token no longer valid' }, 'id = ?', [w.id]); }
    catch (e) { if (e instanceof MetaError && e.isAuth) await markTokenInvalid(w.id, e.message); }
  }
  return n;
}
module.exports = {
  signupConfig, completeEmbeddedSignup, attachWaba, listForTenant, sync, disconnect, resolveSender, setDefault, registerNumber,
  profile, updateProfile, requestCode, verifyCode, setLabel, healthCheckAll, tokenOf, markTokenInvalid, getWabaRow, summarize, shapeNumber, shapeWaba, metaErr, numberWithToken,
};
