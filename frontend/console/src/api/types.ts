export type StaffRole = 'super_admin' | 'support' | 'finance';
export interface Staff { id: number; email: string; name: string; role: StaffRole; status: string; totp_enabled: boolean; last_login_at?: string | null; created_at: string }
export interface Tenant { id: number; name: string; kind: string; status: string; plan_id: number | null; contact_email?: string; contact_phone?: string; country?: string; timezone?: string; website?: string; gstin?: string; address?: string; external_ref?: string; suspended_reason?: string | null; created_at: string }
export interface Plan { id: number; code: string; name: string; description?: string; price_paise: number; included_msgs: number; fee_per_msg_paise: number; monthly_msg_cap: number; max_numbers: number; max_api_keys: number; max_webhooks: number; rate_per_sec: number; is_public: number; is_active: number }
export interface Invoice { id: number; tenant_id: number; number: string; period_start: string; period_end: string; plan_code: string; lines: { description: string; quantity: number; unit_paise: number; amount_paise: number }[]; subtotal_paise: number; tax_paise: number; total_paise: number; paid_paise: number; status: string; issued_at: string; due_at: string; paid_at?: string | null; void_reason?: string | null; payments?: { id: number; amount_paise: number; method?: string; reference?: string; note?: string; created_at: string }[] }
export interface PhoneNumber { id: number; tenant_id?: number; phone_number_id: string; display_phone?: string; verified_name?: string; label?: string; quality_rating?: string; messaging_tier?: string; status?: string; name_status?: string; platform_type?: string; registered: boolean | number; register_error?: string | null; is_default?: boolean }
export interface Waba { id: number; tenant_id: number; waba_id: string; business_id?: string; name?: string; currency?: string; review_status?: string; business_verification?: string; status: string; token_valid: boolean; subscribed: boolean; last_error?: string | null; last_synced_at?: string | null; created_at: string; numbers?: PhoneNumber[] }
export interface Message { id: number; direction: 'in' | 'out'; wamid?: string; wa_id: string; type: string; template?: { name: string; language: string }; category?: string; pricing_category?: string; billable: boolean; status: string; preview?: string; error?: { code: string; message: string }; client_ref?: string; created_at: string; sent_at?: string; delivered_at?: string; read_at?: string; failed_at?: string; tenant_id?: number }
export interface ApiKey { id: number; name: string; prefix: string; scopes: string[]; status: string; ip_allowlist?: string | null; rate_per_sec?: number | null; last_used_at?: string | null; expires_at?: string | null; created_at: string; revoked_at?: string | null }
export interface PortalUser { id: number; email: string; name: string; role: string; status: string; email_verified: boolean; last_login_at?: string | null; created_at: string }
export interface Stats {
  tenants: Record<string, number>; messages_24h: { out: number; failed: number; in: number };
  webhook_inbox: Record<string, number>; webhook_deliveries: Record<string, number>;
  numbers_low_quality: number; wabas_invalid_token: number; top_tenants_this_month: { tenant_id: number; n: number }[];
  invoices_outstanding: { count: number; due_paise: number }; jobs: string[];
}
export interface TenantDetail {
  tenant: Tenant; plan: Plan;
  overview: { plan: Plan; period_start: string; sent_this_period: number; included: number; monthly_cap: number | null; overage_msgs: number; numbers_used: number; api_keys_used: number; webhooks_used: number };
  counts: { users: number; api_keys: number; wabas: number; numbers: number; templates: number; unpaid_invoices: number };
}
export interface UsageSummary { from: string; to: string; totals: Record<string, number>; by_category: Record<string, Record<string, number>>; daily: { day: string; category: string; sent: number; delivered: number; read: number; failed: number; inbound: number }[] }
