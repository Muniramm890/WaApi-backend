'use strict';
// End-to-end smoke test against a real PostgreSQL + a mock Meta Graph API. Run: DATABASE_URL=... npm test
const http = require('http');
const crypto = require('crypto');
process.env.NODE_ENV = 'test';
process.env.DB_CLIENT = process.env.DB_CLIENT || 'pg';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:pw@localhost:5432/waplatform_test';
process.env.META_APP_ID = '111'; process.env.META_APP_SECRET = 'appsecret'; process.env.META_ES_CONFIG_ID = 'cfg1';
process.env.META_WEBHOOK_VERIFY_TOKEN = 'vt'; process.env.AUTO_APPROVE_TENANTS = 'true'; process.env.RUN_JOBS = 'false';
process.env.SEED_STAFF_EMAIL = 'owner@test.io'; process.env.SEED_STAFF_PASSWORD = 'Owner-Pass-12345'; process.env.LOG_LEVEL = 'error';

let passed = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; throw new Error(m); } passed++; console.log('  ok', m); };
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

// ---- mock Meta Graph ----
const sent = []; let msgSeq = 0;
const graph = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const u = new URL(req.url, 'http://x'); const p = u.pathname.replace(/^\/v[\d.]+/, ''); const j = (o, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (p === '/oauth/access_token') return j({ access_token: 'BUSTOKEN' });
    if (p === '/debug_token') return j({ data: { is_valid: true, user_id: 'fbu1', scopes: ['whatsapp_business_management'], granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['900100'] }] } });
    if (p === '/900100') return j({ id: '900100', name: 'Test School WABA', currency: 'INR', account_review_status: 'APPROVED', message_template_namespace: 'ns' });
    if (p === '/900100/phone_numbers') return j({ data: [{ id: '700200', display_phone_number: '+91 90000 11111', verified_name: 'Test School', quality_rating: 'GREEN', status: 'CONNECTED', platform_type: 'CLOUD_API', messaging_limit_tier: 'TIER_1K' }] });
    if (p === '/900100/subscribed_apps') return j({ success: true });
    if (p === '/700200/messages') { const body = JSON.parse(b); sent.push(body); if (body.to === '910000000000') return j({ error: { message: 'Recipient not on WhatsApp', type: 'OAuthException', code: 131026 } }, 400); return j({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.OUT' + (++msgSeq) }] }); }
    if (p === '/900100/message_templates' && req.method === 'GET') return j({ data: [{ id: 't1', name: 'fee_receipt', language: 'en', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hi {{1}}' }] }] });
    if (p === '/900100/message_templates' && req.method === 'POST') return j({ id: 't2', status: 'PENDING', category: 'MARKETING' });
    return j({ error: { message: 'mock: unhandled ' + req.method + ' ' + p, code: 100 } }, 404);
  });
});
// ---- tenant webhook receiver ----
const received = [];
const receiver = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { received.push({ headers: req.headers, body: JSON.parse(b) }); res.writeHead(200); res.end('ok'); }); });

(async () => {
  process.env.META_GRAPH_BASE = 'http://127.0.0.1:' + (await listen(graph));
  const rport = await listen(receiver);
  const db = require('../src/db'); const cfg = require('../src/config');
  // fresh database each run
  const { Pool } = require('pg'); const admin = new Pool({ connectionString: process.env.DATABASE_URL.replace(/\/[^/]+$/, '/postgres') });
  await admin.query('DROP DATABASE IF EXISTS waplatform_test WITH (FORCE)'); await admin.end();
  await db.connect(); // auto-creates the database
  const { migrate } = require('../src/db/migrate'); const { seed } = require('../src/db/seed');
  ok((await migrate()).length === 1, 'first run creates schema (migration v1)');
  await seed(); ok((await migrate()).length === 0, 'second run is a no-op (idempotent)'); await seed();
  ok(Number((await db.one('SELECT COUNT(*) AS n FROM plans')).n) === 4, 'default plans seeded once');

  const app = require('../src/app').createApp();
  const srv = http.createServer(app); const port = await listen(srv); const URL_ = 'http://127.0.0.1:' + port;
  const call = async (method, path, { body, token, headers = {}, raw } = {}) => {
    const h = { 'Content-Type': 'application/json', ...headers }; if (token) h.Authorization = 'Bearer ' + token;
    const r = await fetch(URL_ + path, { method, headers: h, body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j; try { j = t ? JSON.parse(t) : {}; } catch { j = t; } return { status: r.status, body: j };
  };

  // --- console login + portal signup ---
  let r = await call('POST', '/api/console/auth/login', { body: { email: 'owner@test.io', password: 'Owner-Pass-12345' } });
  ok(r.status === 200 && r.body.access_token, 'staff login works'); const staff = r.body.access_token;
  r = await call('POST', '/api/console/auth/login', { body: { email: 'owner@test.io', password: 'wrong' } }); ok(r.status === 401, 'wrong staff password rejected');
  r = await call('GET', '/api/console/stats'); ok(r.status === 401, 'console requires auth');
  r = await call('POST', '/api/portal/auth/signup', { body: { business_name: 'Test School', name: 'Asha', email: 'Asha@School.test', password: 'Strong-Pass-123', kind: 'school' } });
  ok(r.status === 201 && r.body.status === 'active', 'tenant signup (auto-approve)');
  r = await call('POST', '/api/portal/auth/signup', { body: { business_name: 'Dup School', name: 'Asha', email: 'asha@school.test', password: 'Strong-Pass-123' } }); ok(r.status === 409, 'duplicate email rejected (case-insensitive)');
  r = await call('POST', '/api/portal/auth/login', { body: { email: 'asha@school.test', password: 'Strong-Pass-123' } }); ok(r.status === 200, 'portal login'); const portal = r.body.access_token; const refresh = r.body.refresh_token;
  r = await call('GET', '/api/console/me', { token: portal }); ok(r.status === 401, 'portal token cannot access console');
  r = await call('POST', '/api/portal/auth/refresh', { body: { refresh_token: refresh } }); ok(r.status === 200 && r.body.refresh_token !== refresh, 'refresh token rotates');

  // --- Embedded Signup ---
  r = await call('GET', '/api/portal/whatsapp/signup-config', { token: portal }); ok(r.status === 200 && r.body.state, 'signup-config issues signed state'); const state = r.body.state;
  r = await call('POST', '/api/portal/whatsapp/signup/complete', { token: portal, body: { code: 'abc', state: 'bad.state' } }); ok(r.status === 400, 'bad state rejected');
  r = await call('POST', '/api/portal/whatsapp/signup/complete', { token: portal, body: { code: 'abc', state, waba_id: '900100', phone_number_id: '700200' } });
  ok(r.status === 201 && r.body.data[0].numbers.length === 1 && r.body.data[0].subscribed === true, 'Embedded Signup completes: WABA + number stored, app subscribed');
  const tokRow = await db.one('SELECT token_enc FROM waba_accounts WHERE waba_id = ?', ['900100']); ok(tokRow.token_enc.startsWith('v1:') && !tokRow.token_enc.includes('BUSTOKEN'), 'access token is encrypted at rest');
  r = await call('POST', '/api/portal/templates/sync', { token: portal }); ok(r.status === 200 && r.body.synced === 1, 'templates synced from Meta');

  // --- API key + sending ---
  r = await call('POST', '/api/portal/api-keys', { token: portal, body: { name: 'prod', scopes: ['messages:send', 'messages:read', 'webhooks:manage'] } });
  ok(r.status === 201 && /^wak_/.test(r.body.key), 'API key created (shown once)'); const key = r.body.key;
  r = await call('GET', '/api/v1/ping', { token: key }); ok(r.status === 200 && r.body.scopes.length === 3, 'API key authenticates');
  r = await call('GET', '/api/v1/templates', { token: key }); ok(r.status === 403 && r.body.error.code === 'INSUFFICIENT_SCOPE', 'scope enforcement');
  r = await call('GET', '/api/v1/ping', { token: key + 'x' }); ok(r.status === 401, 'bad API key rejected');
  const tmpl = { to: '9876543210', template: { name: 'fee_receipt', language: 'en', components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ravi' }] }] }, client_ref: 'order-1' };
  r = await call('POST', '/api/v1/messages', { token: key, body: tmpl }); ok(r.status === 201 && r.body.status === 'accepted' && r.body.category === 'utility', 'template message sent via API'); const m1 = r.body;
  ok(sent[0].to === '919876543210', 'recipient normalised to E.164 with default country code');
  r = await call('POST', '/api/v1/messages', { token: key, body: tmpl }); ok(r.status === 200 && r.body.idempotent_replay && r.body.id === m1.id && sent.length === 1, 'idempotent replay (client_ref) does not resend');
  r = await call('POST', '/api/v1/messages', { token: key, body: { to: '9876543210', text: 'hello' } }); ok(r.status === 422 && r.body.error.code === 'OUTSIDE_WINDOW', '24h window enforced for free-form text');
  r = await call('POST', '/api/v1/messages', { token: key, body: { to: '910000000000', template: { name: 'fee_receipt', language: 'en' } } }); ok(r.status === 422 && r.body.error.code === 'UNDELIVERABLE', 'Meta error mapped to friendly code');

  // --- webhooks: signed status + inbound + tenant fan-out ---
  r = await call('POST', '/api/v1/webhooks', { token: key, body: { url: `http://127.0.0.1:${rport}/hook`, events: ['message.status', 'message.received'] } }); ok(r.status === 201 && /^whsec_/.test(r.body.secret), 'tenant webhook endpoint created'); const secret = r.body.secret;
  const sign = (b) => 'sha256=' + crypto.createHmac('sha256', 'appsecret').update(b).digest('hex');
  const hookBody = (changes) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '900100', changes }] });
  const post = (b, sig) => call('POST', '/webhooks/meta', { raw: b, headers: { 'X-Hub-Signature-256': sig } });
  r = await call('GET', '/webhooks/meta?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=777'); ok(r.status === 200 && r.body === 777 || r.body === '777', 'webhook verification handshake');
  const body1 = hookBody([{ field: 'messages', value: { metadata: { phone_number_id: '700200' }, statuses: [{ id: 'wamid.OUT1', status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)), pricing: { billable: true, category: 'utility' } }, { id: 'wamid.OUT1', status: 'read', timestamp: String(Math.floor(Date.now() / 1000)) }] } }]);
  r = await post(body1, 'sha256=deadbeef'); ok(r.status === 401, 'bad webhook signature rejected');
  r = await post(body1, sign(body1)); ok(r.status === 200, 'signed webhook accepted');
  const body2 = hookBody([{ field: 'messages', value: { metadata: { phone_number_id: '700200' }, contacts: [{ wa_id: '919876543210', profile: { name: 'Ravi' } }], messages: [{ from: '919876543210', id: 'wamid.IN1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'STOP' } }] } }]);
  await post(body2, sign(body2)); await post(body2, sign(body2)); // duplicate delivery
  await new Promise((r2) => setTimeout(r2, 800));
  r = await call('GET', '/api/v1/messages/' + m1.id, { token: key }); ok(r.body.status === 'read' && r.body.billable === true && r.body.pricing_category === 'utility', 'status webhooks advance sent->delivered->read and capture pricing');
  r = await call('GET', '/api/v1/messages?direction=in', { token: key }); ok(r.body.data.length === 1, 'inbound stored once despite duplicate delivery');
  const contact = await db.one("SELECT * FROM contacts WHERE wa_id = '919876543210'"); ok(contact.opted_out === 1 && contact.profile_name === 'Ravi', 'STOP keyword opts the contact out');
  r = await call('POST', '/api/portal/templates', { token: portal, body: { name: 'promo_one', category: 'MARKETING', language: 'en', components: [{ type: 'BODY', text: 'Sale!' }] } }); ok(r.status === 201, 'template created via portal');
  await db.update('message_templates', { status: 'APPROVED' }, "name = 'promo_one'");
  r = await call('POST', '/api/v1/messages', { token: key, body: { to: '9876543210', template: { name: 'promo_one', language: 'en' } } }); ok(r.status === 409 && r.body.error.code === 'CONTACT_OPTED_OUT', 'marketing blocked for opted-out contact');
  const { dispatchDue } = require('../src/services/outbound'); await dispatchDue();
  ok(received.length >= 2, 'tenant webhooks delivered (' + received.length + ')');
  const d0 = received.find((x) => x.body.type === 'message.status'); const t = d0.headers['x-wap-signature'].match(/t=(\d+),v1=([a-f0-9]+)/);
  ok(crypto.createHmac('sha256', secret).update(`${t[1]}.${JSON.stringify(d0.body)}`).digest('hex') === t[2], 'tenant webhook signature verifies with endpoint secret');
  // webhook arriving BEFORE the message row exists must be retried, not lost
  const early = hookBody([{ field: 'messages', value: { metadata: { phone_number_id: '700200' }, statuses: [{ id: 'wamid.FUTURE', status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)) }] } }]);
  await post(early, sign(early)); await new Promise((r2) => setTimeout(r2, 400));
  const pend = await db.one("SELECT state FROM webhook_inbox ORDER BY id DESC"); ok(pend.state === 'pending', 'early status webhook is parked for retry (race handled)');

  // --- billing ---
  await call('POST', `/api/console/tenants/${(await db.one('SELECT id FROM tenants')).id}/plan`, { token: staff, body: { plan_id: (await db.one("SELECT id FROM plans WHERE code = 'starter'")).id } });
  const period = new Date().toISOString().slice(0, 7);
  r = await call('POST', '/api/console/invoices/run', { token: staff, body: { period } }); ok(r.status === 200 && r.body.created === 1, 'monthly invoice generated');
  r = await call('POST', '/api/console/invoices/run', { token: staff, body: { period } }); ok(r.body.created === 0, 'invoice generation is idempotent');
  const inv = (await call('GET', '/api/console/invoices', { token: staff })).body.data[0]; ok(inv.total_paise === 117882, 'invoice total = plan fee + 18% tax (' + inv.total_paise + ')');
  r = await call('POST', `/api/console/invoices/${inv.id}/payments`, { token: staff, body: { amount_paise: inv.total_paise, method: 'upi', reference: 'UTR1' } }); ok(r.status === 201, 'payment recorded');
  r = await call('GET', `/api/portal/invoices/${inv.id}`, { token: portal }); ok(r.body.status === 'paid', 'tenant sees invoice as paid');

  // --- suspension gate ---
  const tid = (await db.one('SELECT id FROM tenants')).id;
  await call('POST', `/api/console/tenants/${tid}/suspend`, { token: staff, body: { reason: 'test' } });
  
  r = await call('POST', '/api/v1/messages', { token: key, body: tmpl }); ok(r.status === 200 || r.status === 403, 'suspended tenant cannot send (or replays idempotently)');
  r = await call('POST', '/api/v1/messages', { token: key, body: { ...tmpl, client_ref: 'order-2' } }); ok(r.status === 403 && r.body.error.code === 'TENANT_SUSPENDED', 'suspended tenant blocked with TENANT_SUSPENDED');
  r = await call('GET', '/api/console/stats', { token: staff }); ok(r.status === 200 && r.body.messages_24h.out >= 1, 'console stats');
  console.log(`\nALL ${passed} CHECKS PASSED`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('TEST CRASHED:', e); process.exit(1); });
