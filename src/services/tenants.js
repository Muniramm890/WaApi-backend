'use strict';
const db = require('../db');
const { E } = require('../lib/errors');

const cache = new Map();
const TTL = 15000;

async function loadCtx(id) {
  const tenant = await db.one('SELECT * FROM tenants WHERE id = ?', [id]);
  if (!tenant) return null;
  let plan = tenant.plan_id ? await db.one('SELECT * FROM plans WHERE id = ?', [tenant.plan_id]) : null;
  if (!plan) plan = await db.one("SELECT * FROM plans WHERE code = 'free'");
  if (!plan) plan = { id: null, code: 'none', name: 'No plan', price_paise: 0, included_msgs: 0, fee_per_msg_paise: 0, monthly_msg_cap: 0, max_numbers: 1, max_api_keys: 2, max_webhooks: 1, rate_per_sec: 5 };
  return { tenant, plan };
}
async function getCtx(id) {
  const c = cache.get(id);
  if (c && c.exp > Date.now()) return c.v;
  const v = await loadCtx(id);
  if (v) cache.set(id, { v, exp: Date.now() + TTL });
  return v;
}
const invalidate = (id) => { if (id) cache.delete(Number(id)); else cache.clear(); };

const STATUS_MSG = {
  pending: ['TENANT_PENDING', 'Your account is awaiting approval'],
  suspended: ['TENANT_SUSPENDED', 'Your account is suspended. Please contact support or clear pending invoices'],
  deleted: ['TENANT_DELETED', 'This account has been closed'],
};
// Gate for anything that talks to WhatsApp / consumes quota.
function assertOperational(tenant) {
  if (tenant.status === 'active') return;
  const [code, msg] = STATUS_MSG[tenant.status] || ['TENANT_INACTIVE', 'Account is not active'];
  throw E.forbidden(msg, code);
}

async function countActive(tenantId, what) {
  const q = {
    numbers: "SELECT COUNT(*) AS n FROM phone_numbers p JOIN waba_accounts w ON w.id = p.waba_row_id WHERE p.tenant_id = ? AND w.status = 'active'",
    api_keys: "SELECT COUNT(*) AS n FROM api_keys WHERE tenant_id = ? AND status = 'active'",
    webhooks: "SELECT COUNT(*) AS n FROM webhook_endpoints WHERE tenant_id = ?",
  }[what];
  return Number((await db.one(q, [tenantId])).n);
}
async function assertWithinLimit(plan, tenantId, what, adding = 1) {
  const max = { numbers: plan.max_numbers, api_keys: plan.max_api_keys, webhooks: plan.max_webhooks }[what];
  const have = await countActive(tenantId, what);
  if (have + adding > max) throw E.payment(`Your plan (${plan.name}) allows ${max} ${what.replace('_', ' ')}. Upgrade to add more.`, 'PLAN_LIMIT');
}

const publicTenant = (t) => ({
  id: t.id, name: t.name, kind: t.kind, status: t.status, plan_id: t.plan_id, contact_email: t.contact_email, contact_phone: t.contact_phone,
  country: t.country, timezone: t.timezone, website: t.website, gstin: t.gstin, address: t.address, external_ref: t.external_ref,
  suspended_reason: t.suspended_reason, created_at: t.created_at,
});
const publicPlan = (p) => ({
  id: p.id, code: p.code, name: p.name, description: p.description, price_paise: p.price_paise, included_msgs: p.included_msgs,
  fee_per_msg_paise: p.fee_per_msg_paise, monthly_msg_cap: p.monthly_msg_cap, max_numbers: p.max_numbers, max_api_keys: p.max_api_keys,
  max_webhooks: p.max_webhooks, rate_per_sec: p.rate_per_sec,
});
module.exports = { getCtx, invalidate, assertOperational, assertWithinLimit, countActive, publicTenant, publicPlan };
