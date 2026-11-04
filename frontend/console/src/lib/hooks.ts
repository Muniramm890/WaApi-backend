import { useCallback, useEffect, useRef, useState } from 'react';
import { api, PAGE_SIZE } from '../api/endpoints';
import type { Plan } from '../api/types';
import { useToast } from '../contexts/ToastContext';

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn); fnRef.current = fn;
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    fnRef.current().then((d) => live && setState({ data: d, loading: false })).catch((e) => live && setState((s) => ({ ...s, error: e, loading: false })));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: useCallback(() => setTick((t) => t + 1), []) };
}

// Cursor pagination over "id DESC" lists: the next page is requested with before=<last id>.
export function useCursorList<T extends { id: number }>(fetchPage: (before?: number) => Promise<T[]>, deps: unknown[]) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const ref = useRef(fetchPage); ref.current = fetchPage;
  useEffect(() => {
    let live = true;
    setLoading(true); setError(null);
    ref.current(undefined).then((r) => { if (!live) return; setItems(r); setMore(r.length >= PAGE_SIZE); setLoading(false); })
      .catch((e) => { if (live) { setError(e); setLoading(false); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const loadMore = async () => {
    if (!items.length || loadingMore) return;
    setLoadingMore(true);
    try { const r = await ref.current(items[items.length - 1].id); setItems((p) => [...p, ...r]); setMore(r.length >= PAGE_SIZE); }
    catch (e) { setError(e as Error); } finally { setLoadingMore(false); }
  };
  return { items, loading, more, loadingMore, error, loadMore, reload: useCallback(() => setTick((t) => t + 1), []) };
}

export function useDebounce<T>(value: T, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

// Shared lookups so tables can show names instead of ids.
let tenantCache: Record<number, string> | null = null;
let tenantInflight: Promise<Record<number, string>> | null = null;
export const resetTenantNames = () => { tenantCache = null; tenantInflight = null; };
export function useTenantNames() {
  const [m, setM] = useState<Record<number, string>>(tenantCache || {});
  useEffect(() => {
    if (tenantCache) { setM(tenantCache); return; }
    tenantInflight ||= api.tenants({ limit: 200 }).then((r) => (tenantCache = Object.fromEntries(r.data.map((t) => [t.id, t.name]))));
    tenantInflight.then(setM).catch(() => { tenantInflight = null; });
  }, []);
  return m;
}
export function usePlans() {
  const { data, reload, loading } = useAsync(() => api.plans(), []);
  const plans: Plan[] = data?.data || [];
  return { plans, byId: Object.fromEntries(plans.map((p) => [p.id, p])) as Record<number, Plan>, reload, loading };
}

export function useRun() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>, okMsg?: string): Promise<T | undefined> => {
    setBusy(true);
    try { const r = await fn(); if (okMsg) toast.success(okMsg); return r; }
    catch (e: any) { toast.error(e?.message || 'Something went wrong'); return undefined; }
    finally { setBusy(false); }
  };
  return { run, busy };
}

export function useForm<T extends Record<string, any>>(initial: T) {
  const [v, setV] = useState<T>(initial);
  const set = (k: keyof T) => (e: any) => setV((p) => ({ ...p, [k]: e && e.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));
  return { v, setV, set };
}
