'use strict';
// Dual-dialect data layer (PostgreSQL + MSSQL/Azure SQL).
// Conventions for portable SQL used across the code base:
//  - "?" placeholders only (converted to $1.. or @p1..). Never put a literal "?" inside SQL strings.
//  - No booleans (SMALLINT flags 0/1), no JSON column types (TEXT + JSON.parse), no SQL date functions
//    (timestamps always come from JS), lower-case snake_case identifiers, no reserved words.
//  - Row limits via db.lim(n): { top, tail } -> "SELECT ${top} ... ${tail}".
//  - Inserts via db.insert() (RETURNING id / OUTPUT INSERTED.id).
const cfg = require('../config');
const log = require('../lib/logger');

const isPg = cfg.db.client === 'pg';
const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (...names) => names.forEach((n) => { if (!IDENT.test(n)) throw new Error('Unsafe identifier: ' + n); });

let pool; let ms;

const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };
const toMs = (sql) => { let i = 0; return sql.replace(/\?/g, () => '@p' + (++i)); };

function bindMs(req, params) {
  params.forEach((val, i) => {
    const n = 'p' + (i + 1);
    if (val === null || val === undefined) req.input(n, ms.NVarChar, null);
    else if (val instanceof Date) req.input(n, ms.DateTime2, val);
    else if (typeof val === 'number') req.input(n, Number.isInteger(val) ? ms.BigInt : ms.Float, val);
    else if (typeof val === 'boolean') req.input(n, ms.SmallInt, val ? 1 : 0);
    else req.input(n, ms.NVarChar, String(val));
  });
}
function fixMs(rs) {
  const rows = rs.recordset || [];
  const cols = (rs.recordset && rs.recordset.columns) || {};
  const big = Object.keys(cols).filter((k) => {
    const t = cols[k].type;
    return t === ms.BigInt || String(t && t.name).toLowerCase() === 'bigint';
  });
  if (big.length) for (const r of rows) for (const c of big) if (r[c] !== null && r[c] !== undefined) r[c] = Number(r[c]);
  return rows;
}

async function execPg(sql, params, client) {
  const r = await (client || pool).query(toPg(sql), params.map((p) => (p === undefined ? null : p)));
  return { rows: r.rows, count: r.rowCount || 0 };
}
async function execMs(sql, params, tx) {
  const req = tx ? new ms.Request(tx) : pool.request();
  bindMs(req, params);
  const rs = await req.query(toMs(sql));
  return { rows: fixMs(rs), count: (rs.rowsAffected || []).reduce((a, b) => a + b, 0) };
}

function api(run) {
  return {
    run: (sql, params = []) => run(sql, params),
    async query(sql, params = []) { return (await run(sql, params)).rows; },
    async one(sql, params = []) { return (await run(sql, params)).rows[0] || null; },
    // insert(table, data) -> new id (tables with an "id" column). Pass {id:false} for key-less tables.
    async insert(table, data, opts = {}) {
      const keys = Object.keys(data); ident(table, ...keys);
      const cols = keys.join(', '); const ph = keys.map(() => '?').join(', ');
      const vals = keys.map((k) => data[k]);
      if (opts.id === false) { await run(`INSERT INTO ${table} (${cols}) VALUES (${ph})`, vals); return null; }
      const sql = isPg
        ? `INSERT INTO ${table} (${cols}) VALUES (${ph}) RETURNING id`
        : `INSERT INTO ${table} (${cols}) OUTPUT INSERTED.id VALUES (${ph})`;
      return (await run(sql, vals)).rows[0].id;
    },
    // update(table, data, "id = ? AND tenant_id = ?", [1, 2]) -> affected rows
    async update(table, data, where, wparams = []) {
      const keys = Object.keys(data); ident(table, ...keys);
      if (!keys.length) return 0;
      const set = keys.map((k) => `${k} = ?`).join(', ');
      return (await run(`UPDATE ${table} SET ${set} WHERE ${where}`, [...keys.map((k) => data[k]), ...wparams])).count;
    },
  };
}

const root = api((sql, params) => (isPg ? execPg(sql, params) : execMs(sql, params)));

async function connectPg() {
  const { Pool, types } = require('pg');
  types.setTypeParser(20, (v) => Number(v));    // int8 -> number
  types.setTypeParser(1700, (v) => Number(v));  // numeric -> number
  const mk = (url) => new Pool({ connectionString: url, max: cfg.db.poolMax, ssl: cfg.db.pgSsl ? { rejectUnauthorized: false } : undefined });
  if (!cfg.db.url) throw new Error('DATABASE_URL is required when DB_CLIENT=pg');
  pool = mk(cfg.db.url);
  try { await pool.query('SELECT 1'); return; } catch (e) {
    if (e.code !== '3D000') throw e; // database does not exist -> create it
  }
  const u = new URL(cfg.db.url); const name = decodeURIComponent(u.pathname.slice(1));
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('Cannot auto-create database with that name');
  u.pathname = '/postgres';
  const admin = mk(u.toString());
  try { await admin.query(`CREATE DATABASE "${name}"`); log.info('created database', { name }); } finally { await admin.end(); }
  await pool.end(); pool = mk(cfg.db.url); await pool.query('SELECT 1');
}
async function connectMs() {
  ms = require('mssql');
  const c = cfg.db.mssql;
  if (!c.server || !c.database) throw new Error('MSSQL_SERVER and MSSQL_DATABASE are required when DB_CLIENT=mssql');
  pool = new ms.ConnectionPool({
    server: c.server, port: c.port, database: c.database, user: c.user, password: c.password,
    options: { encrypt: c.encrypt, trustServerCertificate: c.trustCert },
    pool: { max: cfg.db.poolMax, min: 0, idleTimeoutMillis: 30000 }, requestTimeout: 30000,
  });
  pool.on('error', (e) => log.error('mssql pool error', e));
  await pool.connect();
}

async function tx(fn) {
  if (isPg) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(api((s, p) => execPg(s, p, client)));
      await client.query('COMMIT');
      return out;
    } catch (e) { try { await client.query('ROLLBACK'); } catch { /* ignore */ } throw e; } finally { client.release(); }
  }
  const t = new ms.Transaction(pool);
  await t.begin();
  try {
    const out = await fn(api((s, p) => execMs(s, p, t)));
    await t.commit();
    return out;
  } catch (e) { try { await t.rollback(); } catch { /* ignore */ } throw e; }
}

const isUnique = (e) => !!e && (e.code === '23505' || e.number === 2601 || e.number === 2627);
const lim = (n) => {
  const x = Math.max(1, Math.min(10000, parseInt(n, 10) || 50));
  return isPg ? { top: '', tail: `LIMIT ${x}` } : { top: `TOP (${x})`, tail: '' };
};

// Upsert-style counter: UPDATE first, INSERT on miss, retry UPDATE on race.
async function bumpCounter(table, keyCols, keyVals, col, n = 1) {
  ident(table, col, ...keyCols);
  const where = keyCols.map((k) => `${k} = ?`).join(' AND ');
  const upd = () => root.run(`UPDATE ${table} SET ${col} = ${col} + ? WHERE ${where}`, [n, ...keyVals]);
  if ((await upd()).count) return;
  try { await root.insert(table, { ...Object.fromEntries(keyCols.map((k, i) => [k, keyVals[i]])), [col]: n }); }
  catch (e) { if (isUnique(e)) await upd(); else throw e; }
}

module.exports = {
  ...root,
  isPg, isMs: !isPg, tx, lim, isUnique, bumpCounter, ident,
  dialect: cfg.db.client,
  async connect() { if (isPg) await connectPg(); else await connectMs(); log.info('database connected', { dialect: cfg.db.client }); },
  async ping() { await root.query('SELECT 1 AS ok'); return true; },
  async close() { if (pool) { if (isPg) await pool.end(); else await pool.close(); } },
  raw: () => ({ pool, ms }),
};
