'use strict';
// Tech Provider / Embedded Signup / WABA + phone number management calls.
const cfg = require('../config');
const { graph, graphAll } = require('./graph');

// Embedded Signup returns a short-lived `code`; exchange it for the customer's business token.
async function exchangeCode(code) {
  const r = await graph('GET', 'oauth/access_token', {
    query: { client_id: cfg.meta.appId, client_secret: cfg.meta.appSecret, code }, retries: 0,
  });
  return { token: r.access_token, expiresIn: r.expires_in };
}
// Inspect a token: validity, scopes, and which WABAs it was granted on (granular_scopes).
async function debugToken(inputToken) {
  const appToken = `${cfg.meta.appId}|${cfg.meta.appSecret}`;
  const r = await graph('GET', 'debug_token', { token: appToken, query: { input_token: inputToken } });
  const d = r.data || {};
  const waba = (d.granular_scopes || []).find((s) => s.scope === 'whatsapp_business_management');
  return { valid: !!d.is_valid, userId: d.user_id, scopes: d.scopes || [], expiresAt: d.expires_at, wabaIds: (waba && waba.target_ids) || [], raw: d };
}
const getWaba = (wabaId, token) => graph('GET', wabaId, {
  token, query: { fields: 'id,name,currency,timezone_id,message_template_namespace,account_review_status,business_verification_status,on_behalf_of_business_info' },
});
const listPhoneNumbers = (wabaId, token) => graphAll(`${wabaId}/phone_numbers`, {
  token, query: { fields: 'id,display_phone_number,verified_name,quality_rating,name_status,messaging_limit_tier,code_verification_status,platform_type,status,throughput,is_official_business_account' },
});
const getPhoneNumber = (pnId, token) => graph('GET', pnId, {
  token, query: { fields: 'id,display_phone_number,verified_name,quality_rating,name_status,messaging_limit_tier,code_verification_status,platform_type,status,throughput' },
});

// Subscribe OUR app to the customer's WABA so its webhooks reach our callback URL.
const subscribeApp = (wabaId, token) => graph('POST', `${wabaId}/subscribed_apps`, { token, body: {} });
const unsubscribeApp = (wabaId, token) => graph('DELETE', `${wabaId}/subscribed_apps`, { token });
const listSubscribedApps = (wabaId, token) => graph('GET', `${wabaId}/subscribed_apps`, { token });

// Cloud API registration (6-digit two-step PIN) / deregistration.
const registerPhone = (pnId, token, pin) => graph('POST', `${pnId}/register`, { token, body: { messaging_product: 'whatsapp', pin } });
const deregisterPhone = (pnId, token) => graph('POST', `${pnId}/deregister`, { token, body: {} });

// Adding a number outside Embedded Signup (OTP verification flow).
const addPhoneNumber = (wabaId, token, { cc, phone_number, verified_name }) => graph('POST', `${wabaId}/phone_numbers`, { token, body: { cc, phone_number, verified_name } });
const requestCode = (pnId, token, method, language = 'en_US') => graph('POST', `${pnId}/request_code`, { token, body: { code_method: method, language } });
const verifyCode = (pnId, token, code) => graph('POST', `${pnId}/verify_code`, { token, body: { code } });

// Business profile (about, address, description, email, websites, vertical, profile picture handle)
const getProfile = (pnId, token) => graph('GET', `${pnId}/whatsapp_business_profile`, { token, query: { fields: 'about,address,description,email,profile_picture_url,websites,vertical' } });
const updateProfile = (pnId, token, body) => graph('POST', `${pnId}/whatsapp_business_profile`, { token, body: { messaging_product: 'whatsapp', ...body } });

module.exports = {
  exchangeCode, debugToken, getWaba, listPhoneNumbers, getPhoneNumber, subscribeApp, unsubscribeApp, listSubscribedApps,
  registerPhone, deregisterPhone, addPhoneNumber, requestCode, verifyCode, getProfile, updateProfile,
};
