'use strict';
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cfg = require('./config');
const db = require('./db');
const log = require('./lib/logger');
const { ApiError } = require('./lib/errors');
const { requestContext } = require('./middleware/auth');

function corsFor(origins) {
  return cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);                       // non-browser clients
      if (!cfg.prod && !origins.length) return cb(null, true);  // dev convenience
      cb(null, origins.includes(origin));
    },
    credentials: false, maxAge: 600, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'],
  });
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(requestContext);
  // keep the raw bytes for Meta signature verification
  app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { if (req.originalUrl.startsWith('/webhooks/meta')) req.rawBody = buf; } }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/readyz', async (req, res) => { try { await db.ping(); res.json({ ok: true, db: db.dialect }); } catch (e) { res.status(503).json({ ok: false }); } });

  app.use('/', require('./routes/metaRoutes'));
  app.use('/api/v1', require('./routes/publicApi'));                                  // customers' servers (API key); no CORS
  app.use('/api/portal', corsFor(cfg.origins.portal), require('./routes/portal'));      // customer portal frontend
  app.use('/api/console', corsFor(cfg.origins.console), require('./routes/console'));   // control center frontend

  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found', request_id: req.id } }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = 500; let code = 'INTERNAL_ERROR'; let message = 'Something went wrong'; let details;
    if (err instanceof ApiError) { status = err.status; code = err.code; message = err.message; details = err.details; if (err.retryAfter) res.set('Retry-After', String(err.retryAfter)); }
    else if (err.type === 'entity.parse.failed') { status = 400; code = 'INVALID_JSON'; message = 'Request body is not valid JSON'; }
    else if (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE') { status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'Payload too large'; }
    else if (err.name === 'MulterError') { status = 400; code = 'UPLOAD_ERROR'; message = err.message; }
    else log.error('unhandled error', Object.assign(err, { req: req.method + ' ' + req.originalUrl, id: req.id }));
    res.status(status).json({ error: { code, message, details, request_id: req.id } });
  });
  return app;
}
module.exports = { createApp };
