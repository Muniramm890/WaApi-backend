'use strict';
const db = require('../db');

const FIELDS = { sent: 'sent', delivered: 'delivered', read: 'read_count', failed: 'failed', inbound: 'inbound' };
const dayStr = (d = new Date()) => d.toISOString().slice(0, 10);
const monthStart = (d = new Date()) => dayStr(d).slice(0, 8) + '01';

async function bump(tenantId, category, field, n = 1) {
  const col = FIELDS[field]; if (!col) throw new Error('bad usage field ' + field);
  await db.bumpCounter('usage_daily', ['tenant_id', 'day', 'category'], [tenantId, dayStr(), category || 'unknown'], col, n);
}
async function monthSent(tenantId, fromDay = monthStart()) {
  const r = await db.one('SELECT SUM(sent) AS n FROM usage_daily WHERE tenant_id = ? AND day >= ?', [tenantId, fromDay]);
  return Number((r && r.n) || 0);
}
async function summary(tenantId, from, to) {
  const rows = await db.query(
    'SELECT day, category, sent, delivered, read_count, failed, inbound FROM usage_daily WHERE tenant_id = ? AND day >= ? AND day <= ? ORDER BY day, category',
    [tenantId, from, to]);
  const totals = { sent: 0, delivered: 0, read: 0, failed: 0, inbound: 0 }; const byCategory = {};
  for (const r of rows) {
    totals.sent += r.sent; totals.delivered += r.delivered; totals.read += r.read_count; totals.failed += r.failed; totals.inbound += r.inbound;
    const c = (byCategory[r.category] = byCategory[r.category] || { sent: 0, delivered: 0, read: 0, failed: 0, inbound: 0 });
    c.sent += r.sent; c.delivered += r.delivered; c.read += r.read_count; c.failed += r.failed; c.inbound += r.inbound;
  }
  return { from, to, totals, by_category: byCategory, daily: rows.map((r) => ({ day: r.day, category: r.category, sent: r.sent, delivered: r.delivered, read: r.read_count, failed: r.failed, inbound: r.inbound })) };
}
module.exports = { bump, monthSent, summary, dayStr, monthStart };
