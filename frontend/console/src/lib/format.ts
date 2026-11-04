const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
export const money = (paise?: number | null) => inr.format((paise || 0) / 100);
export const num = (n?: number | null) => new Intl.NumberFormat('en-IN').format(n || 0);
export const rupeesToPaise = (s: string) => Math.round(parseFloat(s || '0') * 100);
export const paiseToRupees = (p: number) => (p / 100).toFixed(2);
export function dt(v?: string | null) { if (!v) return '—'; const d = new Date(v); return isNaN(+d) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
export function day(v?: string | null) { if (!v) return '—'; const d = new Date(v); return isNaN(+d) ? v : d.toLocaleDateString(undefined, { dateStyle: 'medium' }); }
export function ago(v?: string | null) {
  if (!v) return 'never';
  const s = Math.floor((Date.now() - new Date(v).getTime()) / 1000);
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`; return day(v);
}
export const title = (s?: string | null) => (s ? s.replace(/[_-]/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '—');
export const currentPeriod = () => new Date().toISOString().slice(0, 7);
export const prevPeriod = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };
export const monthStart = () => new Date().toISOString().slice(0, 8) + '01';
export const today = () => new Date().toISOString().slice(0, 10);
export const safeJson = (s: unknown) => { if (typeof s !== 'string') return s; try { return JSON.parse(s); } catch { return s; } };
export function tone(status?: string | null): 'ok' | 'warn' | 'bad' | 'info' | '' {
  const s = String(status || '').toLowerCase();
  if (['active', 'approved', 'paid', 'delivered', 'read', 'done', 'green', 'connected', 'verified', 'received', 'completed', 'ok'].includes(s)) return 'ok';
  if (['pending', 'issued', 'yellow', 'queued', 'accepted', 'sent', 'invited', 'processing', 'in_appeal'].includes(s)) return s === 'sent' || s === 'accepted' || s === 'queued' ? 'info' : 'warn';
  if (['suspended', 'failed', 'error', 'red', 'overdue', 'disabled', 'rejected', 'disconnected', 'void', 'deleted', 'paused', 'flagged'].includes(s)) return 'bad';
  return '';
}
