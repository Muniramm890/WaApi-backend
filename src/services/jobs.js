'use strict';
// Background jobs with DB leases so multiple instances never run the same job concurrently.
const crypto = require('crypto');
const db = require('../db');
const log = require('../lib/logger');
const cfg = require('../config');
const wabas = require('./wabas');
const tplSvc = require('./templatesSvc');
const outbound = require('./outbound');
const hook = require('./metaWebhook');
const billing = require('./billing');
const usage = require('./usage');

const OWNER = crypto.randomBytes(6).toString('hex');

async function acquire(name, ttlSec) {
  const now = new Date(); const until = new Date(now.getTime() + ttlSec * 1000);
  const n = await db.update('job_locks', { locked_until: until, owner: OWNER }, 'name = ? AND locked_until < ?', [name, now]);
  if (n) return true;
  try { await db.insert('job_locks', { name, locked_until: until, owner: OWNER }, { id: false }); return true; } catch (e) { if (db.isUnique(e)) return false; throw e; }
}
async function release(name) { await db.update('job_locks', { locked_until: new Date(0) }, 'name = ? AND owner = ?', [name, OWNER]); }

const JOBS = {
  inbox: { every: 20, ttl: 60, fn: () => hook.sweep() },
  deliveries: { every: 10, ttl: 60, fn: () => outbound.dispatchDue() },
  templates: { every: 6 * 3600, ttl: 900, fn: async () => { const ts = await db.query("SELECT DISTINCT tenant_id FROM waba_accounts WHERE status = 'active' AND token_valid = 1"); for (const t of ts) { try { await tplSvc.sync(t.tenant_id); } catch (e) { log.warn('template sync failed', { tenant: t.tenant_id, msg: e.message }); } } return ts.length; } },
  health: { every: 12 * 3600, ttl: 900, fn: async () => { const n = await wabas.healthCheckAll(); const ws = await db.query("SELECT id, tenant_id FROM waba_accounts WHERE status = 'active' AND token_valid = 1"); for (const w of ws) { try { await wabas.sync(w.tenant_id, w.id); } catch (e) { log.warn('waba sync failed', { waba: w.id, msg: e.message }); } } return n; } },
  billing: { every: 3600, ttl: 600, fn: async () => { const day = new Date().getUTCDate(); const out = {}; if (day <= 5) out.invoices = await billing.generateInvoices(); out.dues = await billing.enforceDues(); return out; } },
  cleanup: { every: 24 * 3600, ttl: 1800, fn: async () => {
    const r = cfg.retention; const ago = (d) => new Date(Date.now() - d * 86400000);
    const a = await db.run("DELETE FROM webhook_inbox WHERE state IN ('done','skipped') AND received_at < ?", [ago(r.webhookDays)]);
    const b = await db.run("DELETE FROM webhook_deliveries WHERE state <> 'pending' AND created_at < ?", [ago(r.deliveriesDays)]);
    const c = await db.run('DELETE FROM meta_events WHERE created_at < ?', [ago(r.webhookDays)]);
    const d = await db.run('DELETE FROM messages WHERE created_at < ?', [ago(r.messagesDays)]);
    const e = await db.run('DELETE FROM refresh_tokens WHERE expires_at < ?', [ago(1)]);
    return { inbox: a.count, deliveries: b.count, events: c.count, messages: d.count, tokens: e.count, usage_day: usage.dayStr() };
  } },
};

async function run(name) {
  const j = JOBS[name]; if (!j) throw new Error('Unknown job ' + name);
  if (!(await acquire('job:' + name, j.ttl))) return { skipped: true };
  try { const out = await j.fn(); return { ok: true, result: out }; } finally { await release('job:' + name); }
}
const timers = [];
function start() {
  for (const [name, j] of Object.entries(JOBS)) {
    const tick = () => run(name).catch((e) => log.error(`job ${name} failed`, e));
    const t = setInterval(tick, j.every * 1000); t.unref(); timers.push(t);
    setTimeout(tick, 5000 + Math.random() * 5000).unref();
  }
  log.info('background jobs started', { jobs: Object.keys(JOBS) });
}
const stop = () => timers.forEach(clearInterval);
module.exports = { start, stop, run, names: Object.keys(JOBS) };
