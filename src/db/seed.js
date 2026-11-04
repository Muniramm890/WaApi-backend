'use strict';
const db = require('./index');
const cfg = require('../config');
const log = require('../lib/logger');
const { hashPassword } = require('../lib/crypto');

// Placeholder plans - edit prices/limits from the Control Center after first run.
const PLANS = [
  { code: 'free', name: 'Sandbox', description: 'Try the API with a small monthly cap', price_paise: 0, included_msgs: 200, fee_per_msg_paise: 0, monthly_msg_cap: 200, max_numbers: 1, max_api_keys: 2, max_webhooks: 1, rate_per_sec: 5, is_public: 1 },
  { code: 'starter', name: 'Starter', description: 'Small schools and businesses', price_paise: 99900, included_msgs: 5000, fee_per_msg_paise: 20, monthly_msg_cap: 0, max_numbers: 2, max_api_keys: 5, max_webhooks: 3, rate_per_sec: 20, is_public: 1 },
  { code: 'growth', name: 'Growth', description: 'Growing teams', price_paise: 299900, included_msgs: 25000, fee_per_msg_paise: 15, monthly_msg_cap: 0, max_numbers: 5, max_api_keys: 10, max_webhooks: 5, rate_per_sec: 40, is_public: 1 },
  { code: 'scale', name: 'Scale', description: 'High volume', price_paise: 999900, included_msgs: 100000, fee_per_msg_paise: 10, monthly_msg_cap: 0, max_numbers: 20, max_api_keys: 25, max_webhooks: 10, rate_per_sec: 80, is_public: 1 },
];
const DEFAULT_SETTINGS = { tax_percent: '18', grace_days: '7', invoice_due_days: '7', invoice_prefix: 'INV', invoice_seq: '0', signup_open: '1' };

async function seed() {
  const now = new Date();
  for (const p of PLANS) {
    const ex = await db.one('SELECT id FROM plans WHERE code = ?', [p.code]);
    if (!ex) await db.insert('plans', { ...p, is_active: 1, created_at: now, updated_at: now });
  }
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    const ex = await db.one('SELECT skey FROM settings WHERE skey = ?', [k]);
    if (!ex) await db.insert('settings', { skey: k, svalue: v, updated_at: now }, { id: false });
  }
  const anyStaff = await db.one('SELECT id FROM staff_users');
  if (!anyStaff) {
    if (cfg.seed.email && cfg.seed.password) {
      await db.insert('staff_users', {
        email: cfg.seed.email.toLowerCase(), name: cfg.seed.name, pw_hash: await hashPassword(cfg.seed.password),
        role: 'super_admin', status: 'active', created_at: now, updated_at: now,
      });
      log.info('seeded first super_admin', { email: cfg.seed.email });
    } else log.warn('No staff user exists. Set SEED_STAFF_EMAIL and SEED_STAFF_PASSWORD and restart to create the first super_admin.');
  }
}
module.exports = { seed };
