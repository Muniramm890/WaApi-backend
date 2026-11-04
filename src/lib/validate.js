'use strict';
const { E } = require('./errors');

const empty = (x) => x === undefined || x === null || x === '';
const v = {
  str(o, k, { min = 0, max = 500, required = false, trim = true } = {}) {
    let x = o ? o[k] : undefined;
    if (empty(x)) { if (required) throw E.bad(`"${k}" is required`); return undefined; }
    if (typeof x !== 'string') throw E.bad(`"${k}" must be a string`);
    if (trim) x = x.trim();
    if (x.length < min) throw E.bad(`"${k}" must be at least ${min} characters`);
    if (x.length > max) throw E.bad(`"${k}" must be at most ${max} characters`);
    return x;
  },
  int(o, k, { min = -2147483648, max = 2147483647, required = false } = {}) {
    let x = o ? o[k] : undefined;
    if (empty(x)) { if (required) throw E.bad(`"${k}" is required`); return undefined; }
    x = Number(x);
    if (!Number.isInteger(x)) throw E.bad(`"${k}" must be an integer`);
    if (x < min || x > max) throw E.bad(`"${k}" must be between ${min} and ${max}`);
    return x;
  },
  email(o, k, required = true) {
    const x = v.str(o, k, { max: 200, required });
    if (x === undefined) return undefined;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(x)) throw E.bad(`"${k}" must be a valid email`);
    return x.toLowerCase();
  },
  oneOf(o, k, allowed, { required = false } = {}) {
    const x = o ? o[k] : undefined;
    if (empty(x)) { if (required) throw E.bad(`"${k}" is required`); return undefined; }
    if (!allowed.includes(x)) throw E.bad(`"${k}" must be one of: ${allowed.join(', ')}`);
    return x;
  },
  bool(o, k) {
    const x = o ? o[k] : undefined;
    if (x === undefined || x === null) return undefined;
    if (typeof x === 'boolean') return x;
    if (x === 1 || x === '1' || x === 'true') return true;
    if (x === 0 || x === '0' || x === 'false') return false;
    throw E.bad(`"${k}" must be boolean`);
  },
  password(o, k = 'password') {
    const x = typeof o?.[k] === 'string' ? o[k] : '';
    if (x.length < 10) throw E.bad('Password must be at least 10 characters');
    if (x.length > 200) throw E.bad('Password too long');
    if (!/[A-Za-z]/.test(x) || !/[0-9]/.test(x)) throw E.bad('Password must contain letters and numbers');
    return x;
  },
  limit(q, def = 50, max = 200) {
    const n = parseInt(q, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
  },
  cursor(q) {
    if (empty(q)) return undefined;
    const n = Number(q);
    if (!Number.isInteger(n) || n < 0) throw E.bad('"before" must be a positive integer id');
    return n;
  },
  id(x, name = 'id') {
    const n = Number(x);
    if (!Number.isInteger(n) || n <= 0) throw E.bad(`Invalid ${name}`);
    return n;
  },
  isoDay(q, name) {
    if (empty(q)) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q)) throw E.bad(`"${name}" must be YYYY-MM-DD`);
    return q;
  },
};
module.exports = v;
