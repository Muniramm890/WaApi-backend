'use strict';
const { E } = require('./errors');

// In-memory limiters (single instance). For multi-instance deployments put a shared limiter
// (Redis / API gateway) in front. Login endpoints also use DB-backed account lockout.
const fixed = new Map();
function fixedWindow({ windowMs, max, key = (req) => req.ip, message }) {
  return (req, res, next) => {
    const k = key(req); const now = Date.now();
    let b = fixed.get(k);
    if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; fixed.set(k, b); }
    b.n++;
    if (b.n > max) return next(E.tooMany(message || 'Too many requests, slow down', Math.ceil((b.reset - now) / 1000)));
    next();
  };
}

const buckets = new Map();
// token bucket: `rate` tokens/sec, burst = 2 x rate
function take(key, rate) {
  const now = Date.now(); const cap = Math.max(rate, 1) * 2;
  let b = buckets.get(key);
  if (!b) { b = { tokens: cap, ts: now }; buckets.set(key, b); }
  b.tokens = Math.min(cap, b.tokens + ((now - b.ts) / 1000) * rate); b.ts = now;
  if (b.tokens < 1) return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / rate)) };
  b.tokens -= 1; return { ok: true };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of fixed) if (b.reset < now) fixed.delete(k);
  for (const [k, b] of buckets) if (now - b.ts > 10 * 60 * 1000) buckets.delete(k);
}, 60 * 1000).unref();

module.exports = { fixedWindow, take };
