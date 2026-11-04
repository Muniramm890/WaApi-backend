# WA Platform Backend (Meta Tech Provider)

One backend + one database for **three audiences**, each with its own route namespace:

| Audience | Prefix | Auth | Frontend |
|---|---|---|---|
| Control Center (you / your staff) | `/api/console` | JWT (`aud=console`), optional TOTP 2FA | Control Center app |
| Customer Portal (schools / businesses) | `/api/portal` | JWT (`aud=portal`), roles viewer < developer < admin < owner | Portal app |
| Public API (customers' servers) | `/api/v1` | API key (`Authorization: Bearer wak_...`) with scopes | none |
| Meta callbacks | `/webhooks/meta`, `/meta/*` | HMAC signature / verify token | none |

Stack: Node 18+, Express, **PostgreSQL or MSSQL/Azure SQL** (`DB_CLIENT=pg|mssql`). The schema is created automatically on first start.

## Quick start

```bash
cp .env.example .env      # fill DB, JWT_SECRET, ENCRYPTION_KEY, SEED_STAFF_*, META_*
npm install
npm start                 # connects -> creates DB (pg) -> migrates -> seeds -> serves
```

First run: creates every table and index, 4 placeholder plans (edit prices in the Control Center), default settings and the first `super_admin` from `SEED_STAFF_EMAIL/PASSWORD`. Re-running is a no-op. New schema changes = append a migration in `src/db/schema.js` (`migrations[]`); they run in one transaction under a lock, so several instances can boot together.

`npm run migrate` runs migrate + seed without starting the server. `npm test` runs an end-to-end smoke test (needs PostgreSQL + mock Meta; see `test/smoke.js`).

### Database notes
- **PostgreSQL**: the database itself is auto-created if missing.
- **MSSQL / Azure SQL**: create the empty database in Azure first (the app creates all tables). Set `MSSQL_*`.
- All SQL is written once in a portable subset (`?` params, no booleans/JSON types/date functions, `db.lim()` for row limits, `db.insert()` for ids) and the DDL is generated per dialect. The PostgreSQL path is covered by the smoke test; the MSSQL path was reviewed statically (DDL output inspected) but was **not executed against a real SQL Server in the build sandbox. Run `npm start` once against your Azure SQL and `npm test` equivalent flows before going live.**

## Meta (Tech Provider) setup checklist
1. Meta app (type Business) with **WhatsApp** product; business verification complete; App Review for `whatsapp_business_management` + `whatsapp_business_messaging` (+ `business_management` if asked).
2. **Embedded Signup**: create a Facebook Login for Business configuration (WhatsApp Embedded Signup) -> put its id in `META_ES_CONFIG_ID`. Add your Portal domain to the app's allowed domains / JS SDK domains.
3. **Webhooks** (WhatsApp Business Account object): callback `https://<api>/webhooks/meta`, verify token = `META_WEBHOOK_VERIFY_TOKEN`. Subscribe fields: `messages`, `message_template_status_update`, `message_template_quality_update`, `template_category_update`, `phone_number_quality_update`, `phone_number_name_update`, `account_update`, `account_review_update`, `account_alerts`, `business_capability_update`.
4. App settings: **Deauthorize callback** `https://<api>/meta/deauthorize`, **Data deletion request URL** `https://<api>/meta/data-deletion`. Set a privacy policy URL.
5. Env: `META_APP_ID`, `META_APP_SECRET`, `META_API_VERSION` (default `v23.0`; bump as Meta releases new versions), optional `META_SYSTEM_USER_TOKEN` (for staff "attach existing WABA", e.g. migrating the School ERP numbers), `META_BUSINESS_ID`.
6. Billing model: as a Tech Provider your customers add **their own payment method** to their WABA (Meta bills them directly). This platform only invoices **your** plan fee + per-message platform fee (`plans`, `invoices`). Customers with a payment issue get error `131042` mapped to `PAYMENT_ISSUE`.

### Embedded Signup flow (Portal frontend)
1. `GET /api/portal/whatsapp/signup-config` -> `{app_id, config_id, api_version, state}`.
2. Frontend loads the FB JS SDK, listens for the `WA_EMBEDDED_SIGNUP` message event (gives `waba_id`, `phone_number_id`, `business_id`) and calls `FB.login({config_id, response_type:'code', override_default_response_type:true, extras:{setup:{}, sessionInfoVersion:'3'}})` which returns `code`.
3. `POST /api/portal/whatsapp/signup/complete {code, state, waba_id?, phone_number_id?, business_id?}`. The backend exchanges the code, verifies via `debug_token` that the WABA was really granted, enforces plan limits, encrypts + stores the token, subscribes the app to the WABA, stores numbers and registers them on Cloud API when needed.

## What is implemented
- **Tenancy & accounts**: signup (optional staff approval), email verify, forgot/reset password, team invites, roles, lockout after 5 failures, refresh-token rotation with reuse detection, staff TOTP 2FA, audit log.
- **WhatsApp**: Embedded Signup, attach existing WABA (staff), sync, disconnect, number default/label/profile, register/request-code/verify-code, token health checks.
- **Messaging** (`POST /api/v1/messages`, batch, mark-read): text, template, image/video/audio/document/sticker, interactive, location, contacts, reaction. Idempotency (`Idempotency-Key` / `client_ref`), 24h-window enforcement, template-status check, opt-out/opt-in keywords, per-key and per-number rate limits, plan quota, friendly Meta error mapping.
- **Templates**: list/create/delete/sync, live status updates from webhooks.
- **Media**: upload and authenticated download proxy.
- **Webhook pipeline**: signature-verified raw inbox -> async processing -> retry sweeper (handles "status arrives before the message row exists"), idempotent, `meta_events` audit of every field.
- **Tenant webhooks**: HMAC-signed (`X-WAP-Signature: t=..,v1=..`, signed payload `"<t>.<body>"`), exponential backoff, auto-disable, SSRF-guarded (DNS-rebinding safe), test + manual retry + secret rotation.
- **Billing**: plans, usage counters (per category/day), monthly invoices (plan fee + overage fee + tax), manual payments, overdue -> grace -> auto-suspend -> auto-reactivate on payment, plan-change requests.
- **Control Center**: dashboard stats, tenants (create/approve/suspend/delete/plan), WABA/number health (quality, tokens), messages, webhook inbox/reprocess, deliveries, meta events, audit, staff users, settings, manual job runs.
- **Jobs** (DB-leased, multi-instance safe): inbox sweep (20s), deliveries (10s), template sync (6h), token+number health (12h), billing (hourly check), cleanup/retention (daily).

## API quick reference

**Public API** (`/api/v1`, scopes in brackets)
`GET /ping` · `POST /messages` [messages:send] · `POST /messages/batch` · `POST /messages/read` · `GET /messages` `GET /messages/:id` `GET /conversations/:wa_id` [messages:read] · `GET /templates` `GET /templates/:id` [templates:read] · `POST /templates` `POST /templates/sync` `DELETE /templates/:id` [templates:write] · `POST /media` [media:write] · `GET /media/:id` [media:read] · `GET /numbers` [numbers:read] · `GET|POST|PATCH|DELETE /webhooks...` [webhooks:manage] · `GET /contacts` `PATCH /contacts/:wa_id {opted_out}` · `GET /usage` [usage:read]

Send example:
```bash
curl -X POST https://api.example.com/api/v1/messages -H "Authorization: Bearer wak_..." -H "Idempotency-Key: order-123" \
 -H "Content-Type: application/json" \
 -d '{"to":"9876543210","template":{"name":"fee_receipt","language":"en","components":[{"type":"body","parameters":[{"type":"text","text":"Ravi"}]}]}}'
```
Errors are always `{ "error": { "code", "message", "details", "request_id" } }`. Lists use cursor pagination: `?limit=50&before=<id>`.

**Portal** (`/api/portal`): `auth/{signup,login,refresh,logout,verify-email,forgot-password,reset-password}`, `me`, `account`, `plan`, `plans`, `plan-requests`, `invoices`, `team`, `api-keys`, `whatsapp/{signup-config,signup/complete,accounts,numbers/:id/...}`, `audit`, plus every shared endpoint above (messages, templates, media, contacts, webhooks, usage, numbers).

**Console** (`/api/console`): `auth/*`, `me`, `me/totp/*`, `stats`, `tenants[/:id/{approve,suspend,activate,plan,usage,users,api-keys,wabas,wabas/attach,messages}]`, `plans`, `plan-requests`, `invoices[/run|enforce|:id/payments|:id/void]`, `numbers`, `wabas`, `messages`, `webhook-inbox[/reprocess]`, `meta-events`, `deliveries`, `audit`, `settings`, `staff`, `jobs/:name/run`. Staff roles: `super_admin` (all), `support`, `finance`.

## Operational notes
- Keep `ENCRYPTION_KEY` safe and backed up: WABA tokens, webhook secrets and TOTP secrets are AES-256-GCM encrypted with it.
- In-memory rate limiters are per instance; behind several instances put a shared limiter at the gateway.
- `RUN_JOBS=false` on instances that should only serve HTTP.
- Meta API/pricing/policy details change; verify against Meta's current documentation before launch (API version, template categories, pricing categories).
- Not included (by design): payment-gateway collection (invoices are paid via `POST /console/invoices/:id/payments`; add Razorpay/Stripe in `services/billing.js`), WhatsApp Flows endpoints, coexistence history import (events are stored in `meta_events`).
