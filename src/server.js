'use strict';
const cfg = require('./config');
const db = require('./db');
const log = require('./lib/logger');
const { migrate } = require('./db/migrate');
const { seed } = require('./db/seed');
const { createApp } = require('./app');
const jobs = require('./services/jobs');

async function main() {
  await db.connect();
  await migrate();   // first run: creates every table/index automatically (PostgreSQL or MSSQL)
  await seed();      // default plans, settings and the first super_admin
  const app = createApp();
  const server = app.listen(cfg.port, () => log.info('server listening', { port: cfg.port, env: cfg.env, db: db.dialect }));
  if (cfg.runJobs) jobs.start();
  if (!cfg.meta.appId || !cfg.meta.appSecret) log.warn('META_APP_ID / META_APP_SECRET not set: Embedded Signup and webhooks are disabled until configured');

  const shutdown = (sig) => {
    log.info('shutting down', { sig }); jobs.stop();
    server.close(async () => { await db.close().catch(() => {}); process.exit(0); });
    setTimeout(() => process.exit(1), 15000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => log.error('unhandledRejection', e instanceof Error ? e : new Error(String(e))));
}
main().catch((e) => { log.error('fatal startup error', e); process.exit(1); });
