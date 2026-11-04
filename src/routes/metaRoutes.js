'use strict';
// Meta-facing endpoints (no user auth; verified by signature / verify token).
const express = require('express');
const cfg = require('../config');
const db = require('../db');
const log = require('../lib/logger');
const { wrap } = require('../lib/errors');
const { safeEqual, randomHex } = require('../lib/crypto');
const { parseSignedRequest } = require('../meta/signature');
const hook = require('../services/metaWebhook');
const tenantsSvc = require('../services/tenants');
const { audit } = require('../services/audit');

const r = express.Router();

// Webhook verification handshake
r.get('/webhooks/meta', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && cfg.meta.verifyToken && token && safeEqual(String(token), cfg.meta.verifyToken)) return res.status(200).type('text/plain').send(String(challenge));
  return res.sendStatus(403);
});
// Event delivery: verify signature on the RAW body, persist, ACK immediately, process async.
r.post('/webhooks/meta', wrap(async (req, res) => {
  if (!cfg.meta.appSecret) { log.error('META_APP_SECRET missing: cannot verify webhooks'); return res.sendStatus(503); }
  if (!req.rawBody) return res.sendStatus(400);
  const out = await hook.receive(req.rawBody, req.get('x-hub-signature-256'));
  return res.sendStatus(out.accepted ? 200 : 401);
}));

// Required for Meta apps: user removed our app / asked for data deletion
const disconnectByFbUser = async (fbUserId) => {
  const ws = await db.query("SELECT * FROM waba_accounts WHERE fb_user_id = ? AND status = 'active'", [String(fbUserId)]);
  for (const w of ws) { await db.update('waba_accounts', { status: 'disconnected', token_enc: null, token_valid: 0, subscribed: 0, last_error: 'Access revoked by Meta user', updated_at: new Date() }, 'id = ?', [w.id]); tenantsSvc.invalidate(w.tenant_id); await audit(null, 'waba.deauthorized', { tenantId: w.tenant_id, targetType: 'waba', targetId: w.waba_id }); }
  return ws.length;
};
r.post('/meta/deauthorize', wrap(async (req, res) => {
  const p = parseSignedRequest(req.body && req.body.signed_request, cfg.meta.appSecret); if (!p) return res.sendStatus(400);
  await disconnectByFbUser(p.user_id); res.sendStatus(200);
}));
r.post('/meta/data-deletion', wrap(async (req, res) => {
  const p = parseSignedRequest(req.body && req.body.signed_request, cfg.meta.appSecret); if (!p) return res.sendStatus(400);
  const code = 'del_' + randomHex(10);
  await db.insert('deletion_requests', { code, fb_user_id: String(p.user_id), status: 'processing', created_at: new Date() });
  await disconnectByFbUser(p.user_id);
  await db.update('deletion_requests', { status: 'completed', completed_at: new Date() }, 'code = ?', [code]);
  res.json({ url: `${cfg.publicBaseUrl}/meta/data-deletion/status?code=${code}`, confirmation_code: code });
}));
r.get('/meta/data-deletion/status', wrap(async (req, res) => {
  const row = await db.one('SELECT code, status, created_at, completed_at FROM deletion_requests WHERE code = ?', [String(req.query.code || '')]);
  res.status(row ? 200 : 404).json(row || { error: 'Unknown confirmation code' });
}));
module.exports = r;
