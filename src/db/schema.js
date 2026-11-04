'use strict';
// Declarative schema -> dialect-specific idempotent DDL. Add new migrations at the END of `migrations`.
// Column spec: [name, type, {nn, def, ref, pk}]   types: id | bigint | int | flag | ts | text | str:N
const { isPg } = require('./index');

function sqlType(t) {
  if (t === 'id') return isPg ? 'BIGSERIAL PRIMARY KEY' : 'BIGINT IDENTITY(1,1) PRIMARY KEY';
  if (t === 'bigint') return 'BIGINT';
  if (t === 'int') return isPg ? 'INTEGER' : 'INT';
  if (t === 'flag') return 'SMALLINT';
  if (t === 'ts') return isPg ? 'TIMESTAMPTZ' : 'DATETIME2(3)';
  if (t === 'text') return isPg ? 'TEXT' : 'NVARCHAR(MAX)';
  const m = /^str:(\d+)$/.exec(t);
  if (m) { const n = Number(m[1]); return isPg ? `VARCHAR(${n})` : (n > 4000 ? 'NVARCHAR(MAX)' : `NVARCHAR(${n})`); }
  throw new Error('Unknown column type ' + t);
}
function colDdl([name, type, o = {}]) {
  let s = `${name} ${sqlType(type)}`;
  if (type !== 'id') {
    if (o.pk) s += ' NOT NULL PRIMARY KEY'; else if (o.nn) s += ' NOT NULL';
    if (o.def !== undefined) s += ` DEFAULT ${typeof o.def === 'string' ? `'${o.def}'` : o.def}`;
    if (o.ref) s += ` REFERENCES ${o.ref}(id)`;
  }
  return s;
}
const createTable = (t) => {
  const body = t.cols.map(colDdl).join(',\n  ');
  return isPg
    ? `CREATE TABLE IF NOT EXISTS ${t.name} (\n  ${body}\n)`
    : `IF OBJECT_ID(N'${t.name}', N'U') IS NULL CREATE TABLE ${t.name} (\n  ${body}\n)`;
};
const createIndex = (table, [name, cols, o = {}]) => {
  const tail = `${o.unique ? 'UNIQUE ' : ''}INDEX ${name} ON ${table} (${cols.join(', ')})${o.where ? ' WHERE ' + o.where : ''}`;
  return isPg
    ? `CREATE ${tail.replace('INDEX ', 'INDEX IF NOT EXISTS ')}`
    : `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'${name}' AND object_id = OBJECT_ID(N'${table}')) CREATE ${tail}`;
};
const addColumn = (table, spec) => (isPg
  ? `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${colDdl(spec)}`
  : `IF COL_LENGTH(N'${table}', N'${spec[0]}') IS NULL ALTER TABLE ${table} ADD ${colDdl(spec)}`);

const NN = { nn: 1 };
const TS = [['created_at', 'ts', NN], ['updated_at', 'ts', NN]];
const CNT = { nn: 1, def: 0 };

const tables = [
  { name: 'plans', cols: [
    ['id', 'id'], ['code', 'str:40', NN], ['name', 'str:120', NN], ['description', 'str:400'],
    ['price_paise', 'bigint', CNT], ['included_msgs', 'int', CNT], ['fee_per_msg_paise', 'int', CNT],
    ['monthly_msg_cap', 'int', CNT], ['max_numbers', 'int', { nn: 1, def: 1 }], ['max_api_keys', 'int', { nn: 1, def: 3 }],
    ['max_webhooks', 'int', { nn: 1, def: 2 }], ['rate_per_sec', 'int', { nn: 1, def: 10 }],
    ['is_public', 'flag', { nn: 1, def: 1 }], ['is_active', 'flag', { nn: 1, def: 1 }], ...TS,
  ], indexes: [['ux_plans_code', ['code'], { unique: 1 }]] },

  { name: 'tenants', cols: [
    ['id', 'id'], ['name', 'str:200', NN], ['kind', 'str:20', { nn: 1, def: 'business' }], ['status', 'str:20', { nn: 1, def: 'pending' }],
    ['plan_id', 'bigint', { ref: 'plans' }], ['contact_email', 'str:200'], ['contact_phone', 'str:30'], ['country', 'str:2'],
    ['timezone', 'str:60'], ['website', 'str:200'], ['gstin', 'str:20'], ['address', 'str:500'], ['external_ref', 'str:100'],
    ['suspended_reason', 'str:300'], ['grace_until', 'ts'], ['deleted_at', 'ts'], ...TS,
  ], indexes: [
    ['ix_tenants_status', ['status', 'id']],
    ['ux_tenants_external_ref', ['external_ref'], { unique: 1, where: 'external_ref IS NOT NULL' }],
  ] },

  { name: 'portal_users', cols: [
    ['id', 'id'], ['tenant_id', 'bigint', { nn: 1, ref: 'tenants' }], ['email', 'str:200', NN], ['name', 'str:200', NN],
    ['pw_hash', 'str:300', NN], ['role', 'str:20', { nn: 1, def: 'developer' }], ['status', 'str:20', { nn: 1, def: 'active' }],
    ['email_verified', 'flag', CNT], ['verify_token_hash', 'str:64'], ['reset_token_hash', 'str:64'], ['reset_expires', 'ts'],
    ['failed_attempts', 'int', CNT], ['locked_until', 'ts'], ['last_login_at', 'ts'], ...TS,
  ], indexes: [
    ['ux_portal_users_email', ['email'], { unique: 1 }],
    ['ix_portal_users_tenant', ['tenant_id']],
    ['ix_portal_users_verify', ['verify_token_hash'], { where: 'verify_token_hash IS NOT NULL' }],
    ['ix_portal_users_reset', ['reset_token_hash'], { where: 'reset_token_hash IS NOT NULL' }],
  ] },

  { name: 'staff_users', cols: [
    ['id', 'id'], ['email', 'str:200', NN], ['name', 'str:200', NN], ['pw_hash', 'str:300', NN],
    ['role', 'str:20', { nn: 1, def: 'support' }], ['status', 'str:20', { nn: 1, def: 'active' }],
    ['totp_secret_enc', 'text'], ['totp_enabled', 'flag', CNT], ['failed_attempts', 'int', CNT], ['locked_until', 'ts'],
    ['last_login_at', 'ts'], ...TS,
  ], indexes: [['ux_staff_users_email', ['email'], { unique: 1 }]] },

  { name: 'refresh_tokens', cols: [
    ['id', 'id'], ['subject_type', 'str:10', NN], ['subject_id', 'bigint', NN], ['token_hash', 'str:64', NN],
    ['family_id', 'str:40', NN], ['expires_at', 'ts', NN], ['revoked_at', 'ts'], ['ip', 'str:64'], ['user_agent', 'str:300'],
    ['created_at', 'ts', NN],
  ], indexes: [
    ['ux_refresh_hash', ['token_hash'], { unique: 1 }],
    ['ix_refresh_subject', ['subject_type', 'subject_id']],
    ['ix_refresh_family', ['family_id']],
  ] },

  { name: 'api_keys', cols: [
    ['id', 'id'], ['tenant_id', 'bigint', { nn: 1, ref: 'tenants' }], ['name', 'str:100', NN], ['prefix', 'str:16', NN],
    ['key_hash', 'str:64', NN], ['scopes', 'str:300', NN], ['status', 'str:10', { nn: 1, def: 'active' }],
    ['ip_allowlist', 'str:500'], ['rate_per_sec', 'int'], ['last_used_at', 'ts'], ['last_used_ip', 'str:64'],
    ['expires_at', 'ts'], ['created_by', 'bigint'], ['created_at', 'ts', NN], ['revoked_at', 'ts'],
  ], indexes: [
    ['ux_api_keys_prefix', ['prefix'], { unique: 1 }],
    ['ix_api_keys_tenant', ['tenant_id']],
  ] },

  { name: 'waba_accounts', cols: [
    ['id', 'id'], ['tenant_id', 'bigint', { nn: 1, ref: 'tenants' }], ['waba_id', 'str:40', NN], ['business_id', 'str:40'],
    ['name', 'str:200'], ['currency', 'str:10'], ['timezone_id', 'str:20'], ['review_status', 'str:30'],
    ['business_verification', 'str:30'], ['status', 'str:20', { nn: 1, def: 'active' }], ['token_enc', 'text'],
    ['token_type', 'str:20'], ['token_valid', 'flag', { nn: 1, def: 1 }], ['token_checked_at', 'ts'], ['fb_user_id', 'str:40'],
    ['subscribed', 'flag', CNT], ['template_namespace', 'str:80'], ['last_error', 'str:500'], ['last_synced_at', 'ts'], ...TS,
  ], indexes: [
    ['ux_waba_waba_id', ['waba_id'], { unique: 1 }],
    ['ix_waba_tenant', ['tenant_id']],
  ] },

  { name: 'phone_numbers', cols: [
    ['id', 'id'], ['tenant_id', 'bigint', { nn: 1, ref: 'tenants' }], ['waba_row_id', 'bigint', { nn: 1, ref: 'waba_accounts' }],
    ['phone_number_id', 'str:40', NN], ['display_phone', 'str:40'], ['verified_name', 'str:200'], ['quality_rating', 'str:20'],
    ['messaging_tier', 'str:30'], ['name_status', 'str:30'], ['status', 'str:30'], ['platform_type', 'str:20'],
    ['throughput_level', 'str:20'], ['registered', 'flag', CNT], ['pin_enc', 'text'], ['register_error', 'str:300'],
    ['is_default', 'flag', CNT], ['label', 'str:100'], ['last_synced_at', 'ts'], ...TS,
  ], indexes: [
    ['ux_phone_pnid', ['phone_number_id'], { unique: 1 }],
    ['ix_phone_tenant', ['tenant_id']],
    ['ix_phone_waba', ['waba_row_id']],
  ] },

  { name: 'message_templates', cols: [
    ['id', 'id'], ['tenant_id', 'bigint', { nn: 1, ref: 'tenants' }], ['waba_row_id', 'bigint', { nn: 1, ref: 'waba_accounts' }],
    ['meta_template_id', 'str:40'], ['name', 'str:200', NN], ['language', 'str:20', NN], ['category', 'str:30'],
    ['status', 'str:30', { nn: 1, def: 'PENDING' }], ['quality', 'str:20'], ['components', 'text'], ['rejected_reason', 'str:500'],
    ['last_synced_at', 'ts'], ...TS,
  ], indexes: [
    ['ux_tpl_waba_name_lang', ['waba_row_id', 'name', 'language'], { unique: 1 }],
    ['ix_tpl_tenant', ['tenant_id', 'status']],
    ['ix_tpl_meta_id', ['meta_template_id'], { where: 'meta_template_id IS NOT NULL' }],
  ] },

  { name: 'contacts', cols: [
    ['id', 'id'], ['tenant_id', 'bigint', { nn: 1, ref: 'tenants' }], ['wa_id', 'str:20', NN], ['profile_name', 'str:200'],
    ['last_inbound_at', 'ts'], ['opted_out', 'flag', CNT], ['opted_out_at', 'ts'], ...TS,
  ], indexes: [['ux_contacts_tenant_wa', ['tenant_id', 'wa_id'], { unique: 1 }]] },

  { name: 'messages', cols: [
    ['id', 'id'], ['tenant_id', 'bigint', { nn: 1, ref: 'tenants' }], ['phone_row_id', 'bigint', { ref: 'phone_numbers' }],
    ['direction', 'str:3', NN], ['wa_id', 'str:20', NN], ['wamid', 'str:200'], ['msg_type', 'str:20', NN],
    ['template_name', 'str:200'], ['template_lang', 'str:20'], ['category', 'str:20'], ['pricing_category', 'str:30'],
    ['billable', 'flag', CNT], ['body_preview', 'str:500'], ['payload', 'text'], ['status', 'str:20', NN],
    ['error_code', 'str:20'], ['error_message', 'str:500'], ['client_ref', 'str:100'], ['api_key_id', 'bigint'],
    ['source', 'str:10'], ['created_at', 'ts', NN], ['sent_at', 'ts'], ['delivered_at', 'ts'], ['read_at', 'ts'], ['failed_at', 'ts'],
  ], indexes: [
    ['ix_messages_tenant_id', ['tenant_id', 'id']],
    ['ux_messages_wamid', ['wamid'], { unique: 1, where: 'wamid IS NOT NULL' }],
    ['ux_messages_client_ref', ['tenant_id', 'client_ref'], { unique: 1, where: 'client_ref IS NOT NULL' }],
    ['ix_messages_thread', ['tenant_id', 'wa_id', 'id']],
    ['ix_messages_status', ['tenant_id', 'status']],
    ['ix_messages_created', ['created_at']],
  ] },

  { name: 'usage_daily', cols: [
    ['id', 'id'], ['tenant_id', 'bigint', { nn: 1, ref: 'tenants' }], ['day', 'str:10', NN], ['category', 'str:20', NN],
    ['sent', 'int', CNT], ['delivered', 'int', CNT], ['read_count', 'int', CNT], ['failed', 'int', CNT], ['inbound', 'int', CNT],
  ], indexes: [['ux_usage_key', ['tenant_id', 'day', 'category'], { unique: 1 }]] },

  { name: 'webhook_endpoints', cols: [
    ['id', 'id'], ['tenant_id', 'bigint', { nn: 1, ref: 'tenants' }], ['url', 'str:500', NN], ['secret_enc', 'text', NN],
    ['events', 'str:500', { nn: 1, def: '*' }], ['status', 'str:10', { nn: 1, def: 'active' }], ['description', 'str:200'],
    ['consecutive_failures', 'int', CNT], ['last_success_at', 'ts'], ['last_failure_at', 'ts'], ['disabled_reason', 'str:200'], ...TS,
  ], indexes: [['ix_whe_tenant', ['tenant_id']]] },

  { name: 'webhook_deliveries', cols: [
    ['id', 'id'], ['tenant_id', 'bigint', { nn: 1, ref: 'tenants' }], ['endpoint_id', 'bigint', { nn: 1, ref: 'webhook_endpoints' }],
    ['event_id', 'str:40', NN], ['event_type', 'str:50', NN], ['payload', 'text', NN], ['state', 'str:10', { nn: 1, def: 'pending' }],
    ['attempts', 'int', CNT], ['next_attempt_at', 'ts'], ['last_status', 'int'], ['last_error', 'str:500'], ['delivered_at', 'ts'],
    ['created_at', 'ts', NN],
  ], indexes: [
    ['ix_whd_due', ['state', 'next_attempt_at']],
    ['ix_whd_tenant', ['tenant_id', 'id']],
    ['ux_whd_event', ['endpoint_id', 'event_id'], { unique: 1 }],
  ] },

  { name: 'webhook_inbox', cols: [
    ['id', 'id'], ['received_at', 'ts', NN], ['signature_ok', 'flag', CNT], ['payload', 'text', NN],
    ['state', 'str:10', { nn: 1, def: 'pending' }], ['attempts', 'int', CNT], ['last_error', 'str:500'], ['processed_at', 'ts'],
  ], indexes: [['ix_inbox_state', ['state', 'id']]] },

  { name: 'meta_events', cols: [
    ['id', 'id'], ['tenant_id', 'bigint'], ['waba_id', 'str:40'], ['field', 'str:60', NN], ['event', 'str:80'],
    ['payload', 'text'], ['created_at', 'ts', NN],
  ], indexes: [['ix_meta_events_tenant', ['tenant_id', 'id']], ['ix_meta_events_waba', ['waba_id', 'id']]] },

  { name: 'invoices', cols: [
    ['id', 'id'], ['tenant_id', 'bigint', { nn: 1, ref: 'tenants' }], ['number', 'str:30', NN], ['period_start', 'str:10', NN],
    ['period_end', 'str:10', NN], ['plan_code', 'str:40'], ['lines', 'text'], ['subtotal_paise', 'bigint', CNT],
    ['tax_paise', 'bigint', CNT], ['total_paise', 'bigint', CNT], ['paid_paise', 'bigint', CNT],
    ['status', 'str:10', { nn: 1, def: 'issued' }], ['issued_at', 'ts', NN], ['due_at', 'ts', NN], ['paid_at', 'ts'],
    ['void_reason', 'str:300'], ['created_at', 'ts', NN],
  ], indexes: [
    ['ux_invoices_number', ['number'], { unique: 1 }],
    ['ux_invoices_period', ['tenant_id', 'period_start'], { unique: 1, where: "status <> 'void'" }],
    ['ix_invoices_status', ['status', 'due_at']],
  ] },

  { name: 'invoice_payments', cols: [
    ['id', 'id'], ['invoice_id', 'bigint', { nn: 1, ref: 'invoices' }], ['tenant_id', 'bigint', NN], ['amount_paise', 'bigint', NN],
    ['method', 'str:30'], ['reference', 'str:100'], ['note', 'str:300'], ['recorded_by', 'bigint'], ['created_at', 'ts', NN],
  ], indexes: [['ix_invpay_invoice', ['invoice_id']]] },

  { name: 'plan_requests', cols: [
    ['id', 'id'], ['tenant_id', 'bigint', { nn: 1, ref: 'tenants' }], ['plan_id', 'bigint', { nn: 1, ref: 'plans' }],
    ['note', 'str:400'], ['status', 'str:10', { nn: 1, def: 'pending' }], ['requested_by', 'bigint'],
    ['decided_by', 'bigint'], ['created_at', 'ts', NN], ['decided_at', 'ts'],
  ], indexes: [['ix_planreq_status', ['status', 'id']]] },

  { name: 'audit_logs', cols: [
    ['id', 'id'], ['actor_type', 'str:10', NN], ['actor_id', 'bigint'], ['actor_label', 'str:200'], ['tenant_id', 'bigint'],
    ['action', 'str:80', NN], ['target_type', 'str:40'], ['target_id', 'str:60'], ['meta', 'text'], ['ip', 'str:64'],
    ['created_at', 'ts', NN],
  ], indexes: [['ix_audit_tenant', ['tenant_id', 'id']], ['ix_audit_action', ['action', 'id']]] },

  { name: 'settings', cols: [['skey', 'str:80', { pk: 1 }], ['svalue', 'text'], ['updated_at', 'ts', NN]], indexes: [] },
  { name: 'job_locks', cols: [['name', 'str:60', { pk: 1 }], ['locked_until', 'ts', NN], ['owner', 'str:60']], indexes: [] },
  { name: 'deletion_requests', cols: [
    ['id', 'id'], ['code', 'str:40', NN], ['fb_user_id', 'str:40'], ['status', 'str:20', { nn: 1, def: 'received' }],
    ['created_at', 'ts', NN], ['completed_at', 'ts'],
  ], indexes: [['ux_delreq_code', ['code'], { unique: 1 }]] },
];

// Ordered, append-only. Each entry returns a list of statements (each executed as its own batch).
const migrations = [
  { version: 1, name: 'initial_schema', up: () => {
    const out = [];
    for (const t of tables) out.push(createTable(t));
    for (const t of tables) for (const ix of t.indexes) out.push(createIndex(t.name, ix));
    return out;
  } },
  // Example for later releases:
  // { version: 2, name: 'add_tenant_notes', up: () => [addColumn('tenants', ['notes', 'str:500'])] },
];

module.exports = { tables, migrations, createTable, createIndex, addColumn };
