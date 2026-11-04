'use strict';
// Public API for customers' servers: /api/v1  (Authorization: Bearer wak_...  or  X-API-Key)
const express = require('express');
const { apiKeyAuth, apiGuard } = require('../middleware/auth');
const tenantApi = require('./tenantApi');
const tenantsSvc = require('../services/tenants');

const r = express.Router();
r.use(apiKeyAuth);
r.get('/ping', (req, res) => res.json({
  ok: true, tenant: { id: req.ctx.tenant.id, name: req.ctx.tenant.name, status: req.ctx.tenant.status },
  plan: tenantsSvc.publicPlan(req.ctx.plan), scopes: [...req.scopes],
}));
r.use('/', tenantApi(apiGuard));
module.exports = r;
