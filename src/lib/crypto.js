'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const cfg = require('../config');
const scrypt = promisify(crypto.scrypt);

// ---- AES-256-GCM: secrets at rest (WABA tokens, webhook secrets, TOTP secrets) ----
function encrypt(plain) {
  if (plain === null || plain === undefined) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cfg.encKeyBuf, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}
function decrypt(blob) {
  if (!blob) return null;
  const [ver, iv, tag, data] = String(blob).split(':');
  if (ver !== 'v1') throw new Error('Unknown ciphertext version');
  const d = crypto.createDecipheriv('aes-256-gcm', cfg.encKeyBuf, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (secret, data, enc = 'hex') => crypto.createHmac('sha256', secret).update(data).digest(enc);
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const randomHex = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');
function safeEqual(a, b) {
  const A = Buffer.from(String(a)); const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// ---- passwords (scrypt) ----
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const N = 16384;
  const h = await scrypt(pw, salt, 64, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString('base64')}$${h.toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  try {
    const [alg, N, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const h = await scrypt(pw, Buffer.from(salt, 'base64'), 64, { N: Number(N), r: 8, p: 1 });
    return crypto.timingSafeEqual(h, Buffer.from(hash, 'base64'));
  } catch { return false; }
}
let DUMMY;
async function dummyVerify(pw) { DUMMY = DUMMY || (await hashPassword('dummy-password-for-timing')); await verifyPassword(pw || '', DUMMY); }

// ---- signed state (CSRF protection for Embedded Signup) ----
function signState(obj, ttlSec = 1800) {
  const body = Buffer.from(JSON.stringify({ ...obj, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString('base64url');
  return `${body}.${hmac(cfg.jwtSecret, 'state:' + body, 'base64url')}`;
}
function verifyState(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig || !safeEqual(sig, hmac(cfg.jwtSecret, 'state:' + body, 'base64url'))) return null;
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return o.exp > Date.now() / 1000 ? o : null;
  } catch { return null; }
}

// ---- TOTP (RFC 6238) for staff 2FA ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) {
  let bits = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = ''; for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
function b32decode(s) {
  let bits = ''; for (const ch of s.replace(/=+$/, '').toUpperCase()) { const i = B32.indexOf(ch); if (i >= 0) bits += i.toString(2).padStart(5, '0'); }
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
const newTotpSecret = () => b32encode(crypto.randomBytes(20));
function hotp(secretB32, counter) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32decode(secretB32)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1e6).padStart(6, '0');
}
function totpVerify(secretB32, code) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const step = Math.floor(Date.now() / 30000);
  for (let w = -1; w <= 1; w++) if (safeEqual(hotp(secretB32, step + w), c)) return true;
  return false;
}
const totpUri = (secret, label, issuer = 'WA Platform') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;

module.exports = {
  encrypt, decrypt, sha256, hmac, randomToken, randomHex, safeEqual,
  hashPassword, verifyPassword, dummyVerify, signState, verifyState,
  newTotpSecret, totpVerify, totpUri,
};
