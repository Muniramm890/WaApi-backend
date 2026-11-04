'use strict';
// Endpoints shared by the Public API (/api/v1, API key) and the Customer Portal (/api/portal, JWT).
// `guard(scope)` is injected by the mount point so the same handlers serve both audiences.
const express = require('express');
const multer = require('multer');
const { E, wrap } = require('../lib/errors');
const v = require('../lib/validate');
const db = require('../db');
const { operational } = require('../middleware/auth');
const msg = require('../services/messagesSvc');
const tpl = require('../services/templatesSvc');
const wabas = require('../services/wabas');
const outbound = require('../services/outbound');
const usage = require('../services/usage');
const M = require('../meta/messaging');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 1 } });
const ALLOWED_MIME = /^(image\/(jpeg|png|webp)|video\/(mp4|3gpp)|audio\/(aac|mp4|mpeg|amr|ogg)|application\/(pdf|msword|vnd\.[\w.+-]+)|text\/plain)$/;

module.exports = function tenantApi(guard) {
  const r = express.Router();

  r.get('/numbers', guard('numbers:read'), wrap(async (req, res) => {
    const list = await wabas.listForTenant(req.ctx.tenant.id);
    res.json({ data: list.flatMap((w) => w.numbers.map((n) => ({ ...n, waba_id: w.waba_id, waba_status: w.status, token_valid: w.token_valid }))) });
  }));

  // ---- messages ----
  r.post('/messages', guard('messages:send'), operational, wrap(async (req, res) => {
    const key = req.get('idempotency-key'); const body = { ...req.body }; if (key && !body.client_ref) body.client_ref = key;
    const out = await msg.send(req.ctx, body);
    res.status(out.idempotent_replay ? 200 : 201).json(out);
  }));
  r.post('/messages/batch', guard('messages:send'), operational, wrap(async (req, res) => res.status(207).json(await msg.sendBatch(req.ctx, req.body && req.body.messages))));
  r.post('/messages/read', guard('messages:send'), operational, wrap(async (req, res) => { await msg.markRead(req.ctx, v.str(req.body, 'wamid', { required: true, max: 200 }), req.body.from); res.json({ ok: true }); }));
  r.get('/messages', guard('messages:read'), wrap(async (req, res) => {
    const q = req.query;
    res.json(await msg.list(req.ctx.tenant.id, { direction: q.direction, status: q.status, wa_id: q.wa_id, template: q.template, category: q.category, from: q.from, to: q.to, before: v.cursor(q.before), limit: v.limit(q.limit) }));
  }));
  r.get('/messages/:id', guard('messages:read'), wrap(async (req, res) => res.json(await msg.get(req.ctx.tenant.id, req.params.id))));
  r.get('/conversations/:wa_id', guard('messages:read'), wrap(async (req, res) => res.json(await msg.list(req.ctx.tenant.id, { wa_id: req.params.wa_id, before: v.cursor(req.query.before), limit: v.limit(req.query.limit, 50, 200) }))));

  // ---- contacts ----
  r.get('/contacts', guard('contacts:read'), wrap(async (req, res) => res.json({ data: await msg.listContacts(req.ctx.tenant.id, { q: req.query.q, before: v.cursor(req.query.before), limit: v.limit(req.query.limit) }) })));
  r.patch('/contacts/:wa_id', guard('contacts:write'), wrap(async (req, res) => {
    const o = v.bool(req.body, 'opted_out'); if (o === undefined) throw E.bad('"opted_out" is required');
    res.json(await msg.setOptOut(req.ctx.tenant.id, req.params.wa_id, o));
  }));

  // ---- templates ----
  r.get('/templates', guard('templates:read'), wrap(async (req, res) => res.json({ data: await tpl.list(req.ctx.tenant.id, { status: req.query.status, category: req.query.category, name: req.query.name, wabaRowId: req.query.waba_row_id ? v.id(req.query.waba_row_id) : undefined, before: v.cursor(req.query.before), limit: v.limit(req.query.limit, 100, 500) }) })));
  r.post('/templates/sync', guard('templates:write'), operational, wrap(async (req, res) => res.json(await tpl.sync(req.ctx.tenant.id))));
  r.get('/templates/:id', guard('templates:read'), wrap(async (req, res) => res.json(await tpl.get(req.ctx.tenant.id, v.id(req.params.id)))));
  r.post('/templates', guard('templates:write'), operational, wrap(async (req, res) => res.status(201).json(await tpl.create(req.ctx, req.body || {}))));
  r.delete('/templates/:id', guard('templates:write'), operational, wrap(async (req, res) => { await tpl.remove(req.ctx, v.id(req.params.id)); res.status(204).end(); }));

  // ---- media ----
  r.post('/media', guard('media:write'), operational, upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw E.bad('Send the file as multipart/form-data field "file"');
    if (!ALLOWED_MIME.test(req.file.mimetype)) throw E.bad(`Unsupported media type ${req.file.mimetype}`);
    const { phone, waba } = await wabas.resolveSender(req.ctx.tenant.id, req.body.from);
    try { const out = await M.uploadMedia(phone.phone_number_id, wabas.tokenOf(waba), req.file.buffer, req.file.mimetype, req.file.originalname); res.status(201).json({ id: out.id, mime_type: req.file.mimetype, size: req.file.size }); }
    catch (e) { throw wabas.metaErr(e, 422); }
  }));
  r.get('/media/:id', guard('media:read'), wrap(async (req, res) => {
    if (!/^\d{5,30}$/.test(req.params.id)) throw E.bad('Invalid media id');
    const { waba } = await wabas.resolveSender(req.ctx.tenant.id, req.query.from);
    const token = wabas.tokenOf(waba);
    try {
      const info = await M.getMediaInfo(req.params.id, token);
      const buf = await M.downloadMedia(info.url, token);
      res.set('Content-Type', info.mime_type || 'application/octet-stream').set('Cache-Control', 'private, max-age=300').set('X-Content-Type-Options', 'nosniff').send(buf);
    } catch (e) { throw wabas.metaErr(e, 404); }
  }));

  // ---- outbound webhooks ----
  r.get('/webhooks', guard('webhooks:manage'), wrap(async (req, res) => res.json({ data: await outbound.listEndpoints(req.ctx.tenant.id), event_types: outbound.EVENT_TYPES })));
  r.post('/webhooks', guard('webhooks:manage'), wrap(async (req, res) => res.status(201).json(await outbound.createEndpoint(req.ctx.tenant.id, req.ctx.plan, { url: v.str(req.body, 'url', { required: true, max: 500 }), events: req.body.events, description: v.str(req.body, 'description', { max: 200 }) }))));
  r.patch('/webhooks/:id', guard('webhooks:manage'), wrap(async (req, res) => res.json(await outbound.updateEndpoint(req.ctx.tenant.id, v.id(req.params.id), { url: v.str(req.body, 'url', { max: 500 }), events: req.body.events, description: v.str(req.body, 'description', { max: 200 }), status: req.body.status }))));
  r.delete('/webhooks/:id', guard('webhooks:manage'), wrap(async (req, res) => { await outbound.deleteEndpoint(req.ctx.tenant.id, v.id(req.params.id)); res.status(204).end(); }));
  r.post('/webhooks/:id/test', guard('webhooks:manage'), wrap(async (req, res) => res.json(await outbound.sendTest(req.ctx.tenant.id, v.id(req.params.id)))));
  r.post('/webhooks/:id/rotate-secret', guard('webhooks:manage'), wrap(async (req, res) => res.json(await outbound.rotateSecret(req.ctx.tenant.id, v.id(req.params.id)))));
  r.get('/webhooks/:id/deliveries', guard('webhooks:manage'), wrap(async (req, res) => res.json({ data: await outbound.listDeliveries(req.ctx.tenant.id, { endpointId: v.id(req.params.id), state: req.query.state, before: v.cursor(req.query.before), limit: v.limit(req.query.limit) }) })));
  r.post('/webhook-deliveries/:id/retry', guard('webhooks:manage'), wrap(async (req, res) => { await outbound.retryDelivery(req.ctx.tenant.id, v.id(req.params.id)); res.json({ ok: true }); }));

  // ---- usage ----
  r.get('/usage', guard('usage:read'), wrap(async (req, res) => {
    const to = v.isoDay(req.query.to, 'to') || usage.dayStr(); const from = v.isoDay(req.query.from, 'from') || usage.monthStart();
    res.json(await usage.summary(req.ctx.tenant.id, from, to));
  }));
  return r;
};
