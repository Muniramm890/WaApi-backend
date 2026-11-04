const BASE = ((import.meta.env.VITE_API_BASE as string | undefined) || '').replace(/\/$/, '');
const PREFIX = '/api/console';
const RT_KEY = 'wapc.rt';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown, public requestId?: string) {
    super(message);
  }
}

let access: string | null = null;
let onAuthLost: (() => void) | null = null;
export const setAccessToken = (t: string | null) => { access = t; };
export const setAuthLostHandler = (fn: (() => void) | null) => { onAuthLost = fn; };

// Refresh token: localStorage when "remember this device" is ticked, otherwise sessionStorage.
export const tokenStore = {
  get: () => localStorage.getItem(RT_KEY) ?? sessionStorage.getItem(RT_KEY),
  isRemembered: () => localStorage.getItem(RT_KEY) !== null,
  set(t: string, remember: boolean) {
    localStorage.removeItem(RT_KEY); sessionStorage.removeItem(RT_KEY);
    (remember ? localStorage : sessionStorage).setItem(RT_KEY, t);
  },
  clear() { localStorage.removeItem(RT_KEY); sessionStorage.removeItem(RT_KEY); },
};

type RefreshResult = 'ok' | 'denied' | 'error';
let refreshing: Promise<RefreshResult> | null = null;

async function doRefresh(): Promise<RefreshResult> {
  const rt = tokenStore.get();
  if (!rt) return 'denied';
  const remembered = tokenStore.isRemembered();
  try {
    const r = await fetch(BASE + PREFIX + '/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: rt }) });
    if (r.status === 401 || r.status === 403) { tokenStore.clear(); access = null; return 'denied'; }
    if (!r.ok) return 'error';
    const j = await r.json();
    access = j.access_token; tokenStore.set(j.refresh_token, remembered);
    return 'ok';
  } catch { return 'error'; }
}
export function refreshSession(): Promise<RefreshResult> {
  if (!refreshing) refreshing = doRefresh().finally(() => { refreshing = null; });
  return refreshing;
}

interface Opts { query?: Record<string, unknown>; body?: unknown; auth?: boolean }

export async function request<T = any>(method: string, path: string, opts: Opts = {}): Promise<T> {
  const { query, body, auth = true } = opts;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const url = BASE + PREFIX + path + (qs.toString() ? '?' + qs.toString() : '');
  const exec = () => fetch(url, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(auth && access ? { Authorization: 'Bearer ' + access } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let res: Response;
  try { res = await exec(); } catch { throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection and try again.'); }
  if (res.status === 401 && auth) {
    const st = await refreshSession();
    if (st === 'ok') { try { res = await exec(); } catch { throw new ApiError(0, 'NETWORK', 'Cannot reach the server.'); } }
    else if (st === 'denied') onAuthLost?.();
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  if (!res.ok) {
    const e = json?.error || {};
    throw new ApiError(res.status, e.code || 'ERROR', e.message || `Request failed (${res.status})`, e.details, e.request_id);
  }
  return json as T;
}
