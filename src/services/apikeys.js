'use strict';
const db = require('../db');
const { E } = require('../lib/errors');
const { randomHex, randomToken, sha256, safeEqual } = require('../lib/crypto');
const tenantsSvc = require('./tenants');

const SCOPES = ['messages:send', 'messages:read', 'templates:read', 'templates:write', 'media:read', 'media:write', 'contacts:read', 'contacts:write', 'numbers:read', 'webhooks:manage', 'usage:read'];
const KEY_RE = /^wak_([a-f0-9]{10})_([A-Za-z0-9_-]{30,})$/;

function ipToInt(ip) { const p = ip.split('.').map(Number); return p.length === 4 && p.every((x) => x >= 0 && x < 256) ? ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3] : null; }
function ipAllowed(list, ipRaw) {
  if (!list) return true;
  const ip = String(ipRaw || '').replace(/^::ffff:/, '');
  const items = list.split(',').map((s) => s.trim()).filter(Boolean);
  if (!items.length) return true;
  return items.some((it) => {
    if (!it.includes('/')) return it === ip;
    const [base, bits] = it.split('/'); const b = ipToInt(base); const x = ipToInt(ip); const n = Number(bits);
    if (b === null || x === null || !(n >= 0 && n <= 32)) return false;
    const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
    return ((b & mask) >>> 0) === ((x & mask) >>> 0);
  });
}
function validateIpList(s) {
  if (!s) return null;
  const items = String(s).split(',').map((x) => x.trim()).filter(Boolean);
  for (const it of items) if (!/^[0-9a-fA-F:.]+(\/\d{1,2})?$/.test(it)) throw E.bad(`Invalid IP/CIDR: ${it}`);
  return items.join(',').slice(0, 500) || null;
}
const shape = (k) => ({
  id: k.id, name: k.name, prefix: `wak_${k.prefix}_...`, scopes: k.scopes.split(','), status: k.status, ip_allowlist: k.ip_allowlist,
  rate_per_sec: k.rate_per_sec, last_used_at: k.last_used_at, expires_at: k.expires_at, created_at: k.created_at, revoked_at: k.revoked_at,
});

async function create(tenantId, plan, { name, scopes, ip_allowlist, expires_at, rate_per_sec }, createdBy) {
  await tenantsSvc.assertWithinLimit(plan, tenantId, 'api_keys');
  const sc = (scopes && scopes.length ? scopes : SCOPES).filter((s) => SCOPES.includes(s));
  if (!sc.length) throw E.bad('At least one valid scope is required');
  if (expires_at && !(new Date(expires_at) > new Date())) throw E.bad('"expires_at" must be in the future');
  const prefix = randomHex(5); const raw = `wak_${prefix}_${randomToken(32)}`;
  const id = await db.insert('api_keys', {
    tenant_id: tenantId, name, prefix, key_hash: sha256(raw), scopes: sc.join(','), status: 'active',
    ip_allowlist: validateIpList(ip_allowlist), rate_per_sec: rate_per_sec || null, expires_at: expires_at ? new Date(expires_at) : null,
    created_by: createdBy || null, created_at: new Date(),
  });
  const row = await db.one('SELECT * FROM api_keys WHERE id = ?', [id]);
  return { ...shape(row), key: raw }; // the raw key is returned ONCE
}
const list = async (tenantId) => (await db.query('SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY id DESC', [tenantId])).map(shape);
async function revoke(tenantId, id) {
  const n = await db.update('api_keys', { status: 'revoked', revoked_at: new Date() }, "id = ? AND tenant_id = ? AND status = 'active'", [id, tenantId]);
  if (!n) throw E.notFound('API key');
}

const touched = new Map();
async function authenticate(raw, ip) {
  const m = KEY_RE.exec(String(raw || ''));
  if (!m) throw E.unauth('Invalid API key');
  const row = await db.one('SELECT * FROM api_keys WHERE prefix = ?', [m[1]]);
  if (!row || !safeEqual(row.key_hash, sha256(raw))) throw E.unauth('Invalid API key');
  if (row.status !== 'active') throw E.unauth('API key has been revoked');
  if (row.expires_at && new Date(row.expires_at) < new Date()) throw E.unauth('API key has expired');
  if (!ipAllowed(row.ip_allowlist, ip)) throw E.forbidden('IP address not allowed for this API key', 'IP_NOT_ALLOWED');
  const last = touched.get(row.id) || 0;
  if (Date.now() - last > 60000) { // throttle writes
    touched.set(row.id, Date.now());
    db.update('api_keys', { last_used_at: new Date(), last_used_ip: String(ip || '').slice(0, 64) }, 'id = ?', [row.id]).catch(() => {});
  }
  return row;
}
module.exports = { SCOPES, create, list, revoke, authenticate, shape };
