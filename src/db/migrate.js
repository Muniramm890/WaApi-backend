'use strict';
const db = require('./index');
const { migrations } = require('./schema');
const log = require('../lib/logger');

const LOCK_KEY = 727201;

async function migrate() {
  // bookkeeping table (idempotent, outside the lock transaction)
  try {
    await db.run(db.isPg
      ? 'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name VARCHAR(100) NOT NULL, applied_at TIMESTAMPTZ NOT NULL)'
      : "IF OBJECT_ID(N'schema_migrations', N'U') IS NULL CREATE TABLE schema_migrations (version INT NOT NULL PRIMARY KEY, name NVARCHAR(100) NOT NULL, applied_at DATETIME2(3) NOT NULL)");
  } catch (e) { if (!/already exists/i.test(e.message)) throw e; }

  const applied = await db.tx(async (t) => {
    // serialise concurrent boots (several instances starting at once)
    if (db.isPg) await t.run(`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
    else await t.run("DECLARE @r INT; EXEC @r = sp_getapplock @Resource = N'wa_platform_migrate', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 120000; IF @r < 0 RAISERROR('Could not acquire migration lock', 16, 1);");
    const done = new Set((await t.query('SELECT version FROM schema_migrations')).map((r) => Number(r.version)));
    const ran = [];
    for (const m of migrations) {
      if (done.has(m.version)) continue;
      for (const stmt of m.up()) await t.run(stmt);
      await t.insert('schema_migrations', { version: m.version, name: m.name, applied_at: new Date() }, { id: false });
      ran.push(m.version);
    }
    return ran;
  });
  if (applied.length) log.info('migrations applied', { versions: applied }); else log.info('schema up to date');
  return applied;
}
module.exports = { migrate };
