# WA Platform · Control Center (frontend)

React + TypeScript + Vite single-page app for platform staff. Talks to the backend under `/api/console`.

## Run
```bash
cp .env.example .env     # VITE_API_BASE=https://your-api-host
npm install
npm run dev              # local
npm run build            # outputs dist/ (deploy to Cloudflare Workers / Pages / any static host)
```
Backend must allow this site in `CONSOLE_ORIGINS` (CORS). `wrangler.jsonc` and `public/_redirects` already provide the SPA fallback for Cloudflare.

## Screens
Dashboard (alerts, 24h traffic, top customers) · Customers (search, create, approve, suspend, delete; detail tabs: overview/plan, usage chart, users, API keys, WhatsApp accounts + attach/sync/disconnect, messages) · Plans (+ plan change requests) · Billing (generate invoices, enforce dues, record payments, void) · WhatsApp health (numbers, accounts) · Messages · Webhooks (Meta inbox + reprocess, customer deliveries, Meta events) · Audit log · Settings + manual jobs · Staff (super admin) · My account (password, 2FA).

## Notes
- Role-aware: `super_admin`, `support`, `finance` (mirrors backend checks; the backend is the real authority).
- Sign-in keeps the refresh token in `sessionStorage`, or `localStorage` when "Keep me signed in" is ticked. Access tokens live in memory only.
- No native `alert/confirm/prompt`: everything uses the shared `useDialog()` + `Modal` components.
