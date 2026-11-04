'use strict';
const db = require('../db');
let cache = null; let at = 0;
async function all() {
  if (cache && Date.now() - at < 10000) return cache;
  const rows = await db.query('SELECT skey, svalue FROM settings');
  cache = Object.fromEntries(rows.map((r) => [r.skey, r.svalue])); at = Date.now();
  return cache;
}
async function get(key, def) { const a = await all(); return a[key] !== undefined && a[key] !== null ? a[key] : def; }
async function set(key, value) {
  const now = new Date();
  const n = await db.update('settings', { svalue: String(value), updated_at: now }, 'skey = ?', [key]);
  if (!n) { try { await db.insert('settings', { skey: key, svalue: String(value), updated_at: now }, { id: false }); } catch (e) { if (!db.isUnique(e)) throw e; await db.update('settings', { svalue: String(value), updated_at: now }, 'skey = ?', [key]); } }
  cache = null;
}
// atomic-ish sequence (invoice numbers)
async function nextSeq(key) {
  return db.tx(async (t) => {
    const r = await t.one('SELECT svalue FROM settings WHERE skey = ?', [key]);
    const n = (r ? parseInt(r.svalue, 10) || 0 : 0) + 1;
    if (r) await t.update('settings', { svalue: String(n), updated_at: new Date() }, 'skey = ?', [key]);
    else await t.insert('settings', { skey: key, svalue: String(n), updated_at: new Date() }, { id: false });
    cache = null; return n;
  });
}
module.exports = { all, get, set, nextSeq };
