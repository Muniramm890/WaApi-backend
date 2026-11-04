'use strict';
const { hmac, safeEqual } = require('../lib/crypto');

// X-Hub-Signature-256: sha256=<hmac of raw body with the app secret>
function verifyWebhookSignature(rawBody, header, appSecret) {
  if (!appSecret || !header || !rawBody) return false;
  const expected = 'sha256=' + hmac(appSecret, rawBody);
  return safeEqual(expected, header);
}
// signed_request used by deauthorize / data-deletion callbacks: <sig>.<payload> (base64url)
function parseSignedRequest(signed, appSecret) {
  const [sig, payload] = String(signed || '').split('.');
  if (!sig || !payload || !appSecret) return null;
  const expected = hmac(appSecret, payload, 'base64url');
  if (!safeEqual(expected, sig)) return null;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
}
module.exports = { verifyWebhookSignature, parseSignedRequest };
