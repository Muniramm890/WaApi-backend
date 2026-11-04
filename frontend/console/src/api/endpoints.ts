import { request as r } from './client';
import type { Staff, Tenant, TenantDetail, Plan, Invoice, Waba, PhoneNumber, Message, ApiKey, PortalUser, Stats, UsageSummary } from './types';

type Page<T> = { data: T[]; next_before?: number | null };
const P = 50;

export const api = {
  // auth
  login: (email: string, password: string, totp?: string) => r<{ access_token: string; refresh_token: string; user: Staff }>('POST', '/auth/login', { auth: false, body: { email, password, totp: totp || undefined } }),
  logout: (refresh_token: string) => r('POST', '/auth/logout', { auth: false, body: { refresh_token } }),
  me: () => r<{ user: Staff }>('GET', '/me'),
  changePassword: (current_password: string, new_password: string) => r('POST', '/me/password', { body: { current_password, new_password } }),
  totpSetup: () => r<{ secret: string; otpauth_uri: string }>('POST', '/me/totp/setup'),
  totpEnable: (code: string) => r('POST', '/me/totp/enable', { body: { code } }),
  totpDisable: (password: string) => r('POST', '/me/totp/disable', { body: { password } }),
  stats: () => r<Stats>('GET', '/stats'),

  // tenants
  tenants: (q: { q?: string; status?: string; before?: number; limit?: number }) => r<Page<Tenant>>('GET', '/tenants', { query: { limit: P, ...q } }),
  createTenant: (b: { business_name: string; owner_name: string; owner_email: string; kind?: string; plan_id?: number }) => r<{ tenant_id: number; owner_id: number }>('POST', '/tenants', { body: b }),
  tenant: (id: number) => r<TenantDetail>('GET', `/tenants/${id}`),
  updateTenant: (id: number, b: Partial<Tenant>) => r('PATCH', `/tenants/${id}`, { body: b }),
  approveTenant: (id: number) => r('POST', `/tenants/${id}/approve`),
  activateTenant: (id: number) => r('POST', `/tenants/${id}/activate`),
  suspendTenant: (id: number, reason: string) => r('POST', `/tenants/${id}/suspend`, { body: { reason } }),
  deleteTenant: (id: number) => r('DELETE', `/tenants/${id}`),
  setTenantPlan: (id: number, plan_id: number) => r('POST', `/tenants/${id}/plan`, { body: { plan_id } }),
  tenantUsage: (id: number, from?: string, to?: string) => r<UsageSummary>('GET', `/tenants/${id}/usage`, { query: { from, to } }),
  tenantUsers: (id: number) => r<{ data: PortalUser[] }>('GET', `/tenants/${id}/users`),
  tenantKeys: (id: number) => r<{ data: ApiKey[] }>('GET', `/tenants/${id}/api-keys`),
  revokeKey: (tid: number, kid: number) => r('POST', `/tenants/${tid}/api-keys/${kid}/revoke`),
  tenantWabas: (id: number) => r<{ data: Waba[] }>('GET', `/tenants/${id}/wabas`),
  attachWaba: (id: number, waba_id: string, access_token?: string) => r<Waba>('POST', `/tenants/${id}/wabas/attach`, { body: { waba_id, access_token: access_token || undefined } }),
  syncWaba: (id: number) => r<Waba>('POST', `/wabas/${id}/sync`),
  disconnectWaba: (id: number) => r('POST', `/wabas/${id}/disconnect`),

  // plans
  plans: () => r<{ data: Plan[] }>('GET', '/plans'),
  createPlan: (b: Record<string, unknown>) => r<{ id: number }>('POST', '/plans', { body: b }),
  updatePlan: (id: number, b: Record<string, unknown>) => r('PATCH', `/plans/${id}`, { body: b }),
  planRequests: (status = 'pending') => r<{ data: { id: number; tenant_id: number; plan_id: number; note?: string; status: string; created_at: string }[] }>('GET', '/plan-requests', { query: { status } }),
  decidePlanRequest: (id: number, approve: boolean) => r('POST', `/plan-requests/${id}/${approve ? 'approve' : 'reject'}`),

  // billing
  invoices: (q: { tenant_id?: number; status?: string; before?: number }) => r<{ data: Invoice[] }>('GET', '/invoices', { query: { limit: P, ...q } }),
  invoice: (id: number) => r<Invoice>('GET', `/invoices/${id}`),
  runInvoices: (period?: string) => r<{ period: string; created: number }>('POST', '/invoices/run', { body: { period: period || undefined } }),
  enforceDues: () => r<{ suspended: number }>('POST', '/invoices/enforce'),
  addPayment: (id: number, b: { amount_paise: number; method?: string; reference?: string; note?: string }) => r('POST', `/invoices/${id}/payments`, { body: b }),
  voidInvoice: (id: number, reason: string) => r('POST', `/invoices/${id}/void`, { body: { reason } }),

  // health & logs
  numbers: (q: { quality?: string; status?: string }) => r<{ data: PhoneNumber[] }>('GET', '/numbers', { query: { limit: 200, ...q } }),
  wabas: (q: { token_valid?: string; status?: string }) => r<{ data: Waba[] }>('GET', '/wabas', { query: { limit: 200, ...q } }),
  messages: (q: { tenant_id?: number; status?: string; direction?: string; error_code?: string; before?: number }) => r<Page<Message>>('GET', '/messages', { query: { limit: P, ...q } }),
  inbox: (q: { state: string; before?: number }) => r<{ data: any[] }>('GET', '/webhook-inbox', { query: { limit: P, ...q } }),
  inboxItem: (id: number) => r<any>('GET', `/webhook-inbox/${id}`),
  reprocess: (b: { ids?: number[]; state?: string }) => r<{ requeued: number }>('POST', '/webhook-inbox/reprocess', { body: b }),
  metaEvents: (q: { tenant_id?: number; field?: string; before?: number }) => r<{ data: any[] }>('GET', '/meta-events', { query: { limit: P, ...q } }),
  deliveries: (q: { state: string; before?: number }) => r<{ data: any[] }>('GET', '/deliveries', { query: { limit: P, ...q } }),
  audit: (q: { tenant_id?: number; action?: string; before?: number }) => r<{ data: any[] }>('GET', '/audit', { query: { limit: P, ...q } }),

  // settings / staff / jobs
  settings: () => r<Record<string, string>>('GET', '/settings'),
  saveSettings: (b: Record<string, string>) => r('PUT', '/settings', { body: b }),
  staff: () => r<{ data: Staff[] }>('GET', '/staff'),
  createStaff: (b: { email: string; name: string; role: string; password: string }) => r<{ id: number }>('POST', '/staff', { body: b }),
  updateStaff: (id: number, b: Record<string, unknown>) => r('PATCH', `/staff/${id}`, { body: b }),
  resetStaffPassword: (id: number, password: string) => r('POST', `/staff/${id}/reset-password`, { body: { password } }),
  runJob: (name: string) => r<{ ok?: boolean; skipped?: boolean; result?: unknown }>('POST', `/jobs/${name}/run`),
};
export const PAGE_SIZE = P;
