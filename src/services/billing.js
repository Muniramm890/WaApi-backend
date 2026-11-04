'use strict';
const db = require('../db');
const log = require('../lib/logger');
const { E } = require('../lib/errors');
const settings = require('./settings');
const usage = require('./usage');
const tenantsSvc = require('./tenants');
const { audit } = require('./audit');

const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const pad = (n, w = 2) => String(n).padStart(w, '0');

async function assertQuota(ctx) {
  const cap = ctx.plan.monthly_msg_cap;
  if (cap > 0 && (await usage.monthSent(ctx.tenant.id)) >= cap) throw E.payment(`Monthly message cap (${cap}) for the ${ctx.plan.name} plan has been reached. Upgrade your plan to continue.`, 'QUOTA_EXCEEDED');
}
async function overview(ctx) {
  const sent = await usage.monthSent(ctx.tenant.id);
  const p = ctx.plan;
  return { plan: tenantsSvc.publicPlan(p), period_start: usage.monthStart(), sent_this_period: sent, included: p.included_msgs, monthly_cap: p.monthly_msg_cap || null, overage_msgs: Math.max(0, sent - p.included_msgs), numbers_used: await tenantsSvc.countActive(ctx.tenant.id, 'numbers'), api_keys_used: await tenantsSvc.countActive(ctx.tenant.id, 'api_keys'), webhooks_used: await tenantsSvc.countActive(ctx.tenant.id, 'webhooks') };
}

// period = 'YYYY-MM' (defaults to previous calendar month). Idempotent per tenant+period.
async function generateInvoices(period) {
  const now = new Date();
  let y; let m;
  if (period) { [y, m] = period.split('-').map(Number); } else { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)); y = d.getUTCFullYear(); m = d.getUTCMonth() + 1; }
  if (!(y > 2000 && m >= 1 && m <= 12)) throw E.bad('"period" must be YYYY-MM');
  const start = `${y}-${pad(m)}-01`; const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); const end = `${y}-${pad(m)}-${pad(last)}`;
  const taxPct = Number(await settings.get('tax_percent', '0')) || 0; const dueDays = Number(await settings.get('invoice_due_days', '7')) || 7; const prefix = await settings.get('invoice_prefix', 'INV');
  const tenants = await db.query("SELECT t.id, t.name FROM tenants t WHERE t.status IN ('active','suspended')");
  let created = 0;
  for (const t of tenants) {
    const c = await tenantsSvc.getCtx(t.id); if (!c) continue;
    if (await db.one("SELECT id FROM invoices WHERE tenant_id = ? AND period_start = ? AND status <> 'void'", [t.id, start])) continue;
    const sentRow = await db.one('SELECT SUM(sent) AS n FROM usage_daily WHERE tenant_id = ? AND day >= ? AND day <= ?', [t.id, start, end]);
    const sent = Number((sentRow && sentRow.n) || 0); const p = c.plan; const lines = [];
    if (p.price_paise > 0) lines.push({ description: `${p.name} plan - ${start} to ${end}`, quantity: 1, unit_paise: p.price_paise, amount_paise: p.price_paise });
    const over = Math.max(0, sent - p.included_msgs);
    if (over > 0 && p.fee_per_msg_paise > 0) lines.push({ description: `Platform fee: ${over} messages beyond ${p.included_msgs} included`, quantity: over, unit_paise: p.fee_per_msg_paise, amount_paise: over * p.fee_per_msg_paise });
    const subtotal = lines.reduce((a, l) => a + l.amount_paise, 0);
    if (subtotal <= 0) continue;
    const tax = Math.round((subtotal * taxPct) / 100);
    const seq = await settings.nextSeq('invoice_seq');
    try {
      await db.insert('invoices', { tenant_id: t.id, number: `${prefix}-${y}${pad(m)}-${pad(seq, 5)}`, period_start: start, period_end: end, plan_code: p.code, lines: JSON.stringify(lines), subtotal_paise: subtotal, tax_paise: tax, total_paise: subtotal + tax, paid_paise: 0, status: 'issued', issued_at: now, due_at: addDays(now, dueDays), created_at: now });
      created++;
    } catch (e) { if (!db.isUnique(e)) throw e; }
  }
  log.info('invoices generated', { period: start, created });
  return { period: start, created };
}

// issued -> overdue after due date; suspend after grace days; (reactivation happens on payment)
async function enforceDues() {
  const now = new Date(); const grace = Number(await settings.get('grace_days', '7')) || 0;
  await db.run("UPDATE invoices SET status = 'overdue' WHERE status = 'issued' AND due_at < ?", [now]);
  const late = await db.query("SELECT i.id, i.number, i.tenant_id FROM invoices i JOIN tenants t ON t.id = i.tenant_id WHERE i.status = 'overdue' AND i.due_at < ? AND t.status = 'active'", [addDays(now, -grace)]);
  const done = new Set();
  for (const i of late) {
    if (done.has(i.tenant_id)) continue; done.add(i.tenant_id);
    await db.update('tenants', { status: 'suspended', suspended_reason: `Unpaid invoice ${i.number}`, updated_at: now }, "id = ? AND status = 'active'", [i.tenant_id]);
    tenantsSvc.invalidate(i.tenant_id);
    await audit(null, 'tenant.auto_suspend', { tenantId: i.tenant_id, targetType: 'invoice', targetId: i.number });
  }
  return { suspended: done.size };
}
async function recoverIfClear(tenantId) {
  const t = await db.one('SELECT * FROM tenants WHERE id = ?', [tenantId]);
  if (!t || t.status !== 'suspended' || !String(t.suspended_reason || '').startsWith('Unpaid invoice')) return false;
  if (await db.one("SELECT id FROM invoices WHERE tenant_id = ? AND status = 'overdue'", [tenantId])) return false;
  await db.update('tenants', { status: 'active', suspended_reason: null, updated_at: new Date() }, 'id = ?', [tenantId]);
  tenantsSvc.invalidate(tenantId); await audit(null, 'tenant.auto_reactivate', { tenantId });
  return true;
}
async function recordPayment(invoiceId, { amount_paise, method, reference, note }, actor) {
  const amt = Number(amount_paise);
  if (!Number.isInteger(amt) || amt <= 0) throw E.bad('"amount_paise" must be a positive integer');
  const inv = await db.tx(async (t) => {
    const i = await t.one('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
    if (!i) throw E.notFound('Invoice');
    if (i.status === 'void') throw E.conflict('Invoice is void', 'INVOICE_VOID');
    if (i.status === 'paid') throw E.conflict('Invoice is already paid', 'INVOICE_PAID');
    if (i.paid_paise + amt > i.total_paise) throw E.bad('Payment exceeds the invoice balance');
    await t.insert('invoice_payments', { invoice_id: i.id, tenant_id: i.tenant_id, amount_paise: amt, method: method || null, reference: reference || null, note: note || null, recorded_by: actor && actor.id, created_at: new Date() });
    const paid = i.paid_paise + amt; const full = paid >= i.total_paise;
    await t.update('invoices', full ? { paid_paise: paid, status: 'paid', paid_at: new Date() } : { paid_paise: paid }, 'id = ?', [i.id]);
    return { ...i, paid_paise: paid, status: full ? 'paid' : i.status };
  });
  await recoverIfClear(inv.tenant_id);
  await audit(null, 'invoice.payment', { tenantId: inv.tenant_id, actor, targetType: 'invoice', targetId: inv.number, meta: { amount_paise: amt, method } });
  return inv;
}
async function voidInvoice(id, reason, actor) {
  const i = await db.one('SELECT * FROM invoices WHERE id = ?', [id]);
  if (!i) throw E.notFound('Invoice');
  if (i.paid_paise > 0) throw E.conflict('An invoice with payments cannot be voided', 'INVOICE_HAS_PAYMENTS');
  if (i.status === 'void') return i;
  await db.update('invoices', { status: 'void', void_reason: String(reason || 'Voided').slice(0, 300) }, 'id = ?', [id]);
  await recoverIfClear(i.tenant_id);
  await audit(null, 'invoice.void', { tenantId: i.tenant_id, actor, targetType: 'invoice', targetId: i.number });
}
const shapeInv = (i) => ({ id: i.id, tenant_id: i.tenant_id, number: i.number, period_start: i.period_start, period_end: i.period_end, plan_code: i.plan_code, lines: i.lines ? JSON.parse(i.lines) : [], subtotal_paise: i.subtotal_paise, tax_paise: i.tax_paise, total_paise: i.total_paise, paid_paise: i.paid_paise, status: i.status, issued_at: i.issued_at, due_at: i.due_at, paid_at: i.paid_at, void_reason: i.void_reason });
async function listInvoices({ tenantId, status, limit = 50, before } = {}) {
  const w = ['1 = 1']; const p = [];
  if (tenantId) { w.push('tenant_id = ?'); p.push(tenantId); } if (status) { w.push('status = ?'); p.push(status); } if (before) { w.push('id < ?'); p.push(before); }
  const l = db.lim(limit);
  return (await db.query(`SELECT ${l.top} * FROM invoices WHERE ${w.join(' AND ')} ORDER BY id DESC ${l.tail}`, p)).map(shapeInv);
}
async function getInvoice(id, tenantId) {
  const i = await db.one('SELECT * FROM invoices WHERE id = ?' + (tenantId ? ' AND tenant_id = ?' : ''), tenantId ? [id, tenantId] : [id]);
  if (!i) throw E.notFound('Invoice');
  const payments = await db.query('SELECT id, amount_paise, method, reference, note, created_at FROM invoice_payments WHERE invoice_id = ? ORDER BY id', [id]);
  return { ...shapeInv(i), payments };
}
module.exports = { assertQuota, overview, generateInvoices, enforceDues, recoverIfClear, recordPayment, voidInvoice, listInvoices, getInvoice };
