'use strict';
require('dotenv').config();
const crypto = require('crypto');
const env = process.env;

const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const prod = env.NODE_ENV === 'production';

const cfg = {
  env: env.NODE_ENV || 'development',
  prod,
  port: Number(env.PORT) || 8080,
  publicBaseUrl: String(env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  trustProxy: bool(env.TRUST_PROXY, prod),
  runJobs: bool(env.RUN_JOBS, true),
  db: {
    client: String(env.DB_CLIENT || 'pg').toLowerCase(),
    url: env.DATABASE_URL,
    pgSsl: bool(env.PG_SSL, false),
    poolMax: Number(env.DB_POOL_MAX) || 10,
    mssql: {
      server: env.MSSQL_SERVER,
      port: Number(env.MSSQL_PORT) || 1433,
      database: env.MSSQL_DATABASE,
      user: env.MSSQL_USER,
      password: env.MSSQL_PASSWORD,
      encrypt: bool(env.MSSQL_ENCRYPT, true),
      trustCert: bool(env.MSSQL_TRUST_CERT, false),
    },
  },
  jwtSecret: env.JWT_SECRET,
  encKey: env.ENCRYPTION_KEY,
  accessTtlSec: Number(env.ACCESS_TTL_SEC) || 900,
  refreshTtlDays: Number(env.REFRESH_TTL_DAYS) || 30,
  origins: { console: list(env.CONSOLE_ORIGINS), portal: list(env.PORTAL_ORIGINS) },
  meta: {
    appId: env.META_APP_ID,
    appSecret: env.META_APP_SECRET,
    esConfigId: env.META_ES_CONFIG_ID,
    apiVersion: env.META_API_VERSION || 'v23.0',
    graphBase: String(env.META_GRAPH_BASE || 'https://graph.facebook.com').replace(/\/$/, ''),
    systemToken: env.META_SYSTEM_USER_TOKEN,
    businessId: env.META_BUSINESS_ID,
    verifyToken: env.META_WEBHOOK_VERIFY_TOKEN,
  },
  autoApprove: bool(env.AUTO_APPROVE_TENANTS, false),
  seed: { email: env.SEED_STAFF_EMAIL, password: env.SEED_STAFF_PASSWORD, name: env.SEED_STAFF_NAME || 'Platform Owner' },
  defaultCountryCode: String(env.DEFAULT_COUNTRY_CODE || '91'),
  mail: { url: env.SMTP_URL, from: env.MAIL_FROM || 'no-reply@localhost' },
  retention: {
    messagesDays: Number(env.RETENTION_DAYS_MESSAGES) || 180,
    webhookDays: Number(env.RETENTION_DAYS_WEBHOOK) || 30,
    deliveriesDays: Number(env.RETENTION_DAYS_DELIVERIES) || 30,
  },
  optOutWords: list(env.OPT_OUT_KEYWORDS || 'STOP,UNSUBSCRIBE,CANCEL,END,QUIT').map((s) => s.toUpperCase()),
  optInWords: list(env.OPT_IN_KEYWORDS || 'START,SUBSCRIBE,UNSTOP').map((s) => s.toUpperCase()),
};

function fail(msg) { throw new Error('[config] ' + msg); }

if (!['pg', 'mssql'].includes(cfg.db.client)) fail('DB_CLIENT must be "pg" or "mssql"');

if (prod) {
  if (!cfg.jwtSecret || cfg.jwtSecret.length < 32) fail('JWT_SECRET (>=32 chars) is required in production');
  if (!cfg.encKey || Buffer.from(cfg.encKey, 'base64').length !== 32) fail('ENCRYPTION_KEY (32 bytes, base64) is required in production');
} else {
  if (!cfg.jwtSecret) cfg.jwtSecret = 'dev-only-jwt-secret-change-me-0123456789';
  if (!cfg.encKey) cfg.encKey = crypto.createHash('sha256').update('dev-only-encryption-key').digest('base64');
}
cfg.encKeyBuf = Buffer.from(cfg.encKey, 'base64');
if (cfg.encKeyBuf.length !== 32) fail('ENCRYPTION_KEY must decode to exactly 32 bytes');

module.exports = cfg;
