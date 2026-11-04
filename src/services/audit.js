'use strict';
const db = require('../db');
const log = require('../lib/logger');

// Best-effort: auditing must never break the request.
async function audit(req, action, { tenantId, targetType, targetId, meta, actor } = {}) {
  try {
    const a = actor || (req && req.actor) || { type: 'system' };
    await db.insert('audit_logs', {
      actor_type: a.type, actor_id: a.id || null, actor_label: a.label ? String(a.label).slice(0, 200) : null,
      tenant_id: tenantId || (req && req.ctx && req.ctx.tenant && req.ctx.tenant.id) || null, action,
      target_type: targetType || null, target_id: targetId === undefined || targetId === null ? null : String(targetId).slice(0, 60),
      meta: meta ? JSON.stringify(meta).slice(0, 4000) : null, ip: req && req.ip ? String(req.ip).slice(0, 64) : null, created_at: new Date(),
    });
  } catch (e) { log.warn('audit write failed', { action, msg: e.message }); }
}
module.exports = { audit };
