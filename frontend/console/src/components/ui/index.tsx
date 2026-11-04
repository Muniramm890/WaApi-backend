import { useState, type ReactNode } from 'react';
import { tone } from '../../lib/format';
import { Icon } from './Icon';
import { useToast } from '../../contexts/ToastContext';

export { Modal } from './Modal';
export { Icon } from './Icon';

export function PageHeader({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return <div className="page-head"><h1>{title}</h1>{children && <div className="actions">{children}</div>}{sub && <div className="sub">{sub}</div>}</div>;
}
export const Card = ({ title, actions, children, flat }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flat?: boolean }) => (
  <div className={'card' + (flat ? ' flat' : '')}>
    {title && <div className="card-h"><span>{title}</span>{actions && <span className="actions">{actions}</span>}</div>}
    <div className="card-b">{children}</div>
  </div>
);
export const TableCard = ({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) => (
  <div className="card">{title && <div className="card-h"><span>{title}</span>{actions && <span className="actions">{actions}</span>}</div>}<div className="table-wrap">{children}</div></div>
);
export function Badge({ children, kind }: { children: ReactNode; kind?: 'ok' | 'warn' | 'bad' | 'info' | '' }) { return <span className={'badge ' + (kind || '')}>{children}</span>; }
export function StatusBadge({ status }: { status?: string | null }) { return <Badge kind={tone(status)}>{status ? status.replace(/_/g, ' ') : '—'}</Badge>; }

export const Spinner = () => <span className="spin" role="progressbar" aria-label="Loading" />;
export const Loading = () => <div className="center"><Spinner /></div>;
export const Empty = ({ children = 'Nothing to show yet.' }: { children?: ReactNode }) => <div className="empty">{children}</div>;
export function ErrorBox({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return <div className="alert bad"><Icon name="alert" /><div className="grow">{error.message || 'Something went wrong'}</div>{onRetry && <button className="btn sm" onClick={onRetry}>Retry</button>}</div>;
}
export function Alert({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'bad'; children: ReactNode }) { return <div className={'alert ' + (kind === 'info' ? '' : kind)}><Icon name="alert" /><div className="grow">{children}</div></div>; }

export function Field({ label, hint, children }: { label?: string; hint?: string; children: ReactNode }) {
  return <label className="field">{label && <span className="label">{label}</span>}{children}{hint && <span className="hint">{hint}</span>}</label>;
}
export function Select({ value, onChange, options, placeholder }: { value: string; onChange: (v: string) => void; options: (string | { value: string; label: string })[]; placeholder?: string }) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => { const v = typeof o === 'string' ? o : o.value; const l = typeof o === 'string' ? o : o.label; return <option key={v} value={v}>{l}</option>; })}
    </select>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  return <div className="tabs" role="tablist">{tabs.map((t) => <button key={t.id} role="tab" aria-selected={t.id === value} className={t.id === value ? 'on' : ''} onClick={() => onChange(t.id)}>{t.label}</button>)}</div>;
}
export const Stat = ({ k, v, s }: { k: string; v: ReactNode; s?: ReactNode }) => <div className="card stat" style={{ marginBottom: 0 }}><div className="k">{k}</div><div className="v">{v}</div>{s && <div className="s">{s}</div>}</div>;

export interface Col<T> { header: string; render: (row: T) => ReactNode; className?: string }
export function DataTable<T extends { id: number | string }>({ cols, rows, onRowClick, empty, selected, onToggle }: {
  cols: Col<T>[]; rows: T[]; onRowClick?: (r: T) => void; empty?: ReactNode; selected?: Set<number>; onToggle?: (id: number) => void;
}) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <table className="t">
      <thead><tr>{onToggle && <th style={{ width: 36 }} />}{cols.map((c, i) => <th key={i} className={c.className}>{c.header}</th>)}</tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className={onRowClick ? 'click' : ''} onClick={() => onRowClick?.(r)}>
            {onToggle && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" className="check" checked={!!selected?.has(r.id as number)} onChange={() => onToggle(r.id as number)} aria-label="Select row" /></td>}
            {cols.map((c, i) => <td key={i} className={c.className}>{c.render(r)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
export function LoadMore({ more, loading, onClick }: { more: boolean; loading: boolean; onClick: () => void }) {
  if (!more) return null;
  return <div className="loadmore"><button className="btn" onClick={onClick} disabled={loading}>{loading ? 'Loading…' : 'Load more'}</button></div>;
}
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const toast = useToast(); const [done, setDone] = useState(false);
  return <button className="btn sm" onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); toast.success('Copied'); setTimeout(() => setDone(false), 1500); } catch { toast.error('Copy failed'); } }}><Icon name="copy" />{done ? 'Copied' : label}</button>;
}
export function JsonView({ value }: { value: unknown }) {
  const s = JSON.stringify(value, null, 2);
  return <div><div style={{ marginBottom: 8 }}><CopyButton text={s} label="Copy JSON" /></div><pre className="json">{s}</pre></div>;
}
export function KV({ rows }: { rows: [string, ReactNode][] }) { return <dl className="kv" style={{ margin: 0 }}>{rows.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v ?? '—'}</dd></div>)}</dl>; }
export function Progress({ value, max, bad }: { value: number; max: number; bad?: boolean }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return <div className={'bar' + (bad || pct >= 100 ? ' bad' : '')} role="progressbar" aria-valuenow={pct}><i style={{ width: pct + '%' }} /></div>;
}
export function BarChart({ data }: { data: { label: string; value: number }[] }) {
  if (!data.length) return <Empty>No data for this period.</Empty>;
  const max = Math.max(1, ...data.map((d) => d.value)); const w = 600; const h = 150; const bw = w / data.length;
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h + 18}`} preserveAspectRatio="none" role="img" aria-label="Messages sent per day">
      {data.map((d, i) => { const bh = (d.value / max) * h; return <g key={d.label}><rect x={i * bw + bw * 0.12} y={h - bh} width={bw * 0.76} height={Math.max(bh, d.value ? 1 : 0)} rx="2"><title>{`${d.label}: ${d.value}`}</title></rect>{(data.length <= 16 || i % Math.ceil(data.length / 12) === 0) && <text x={i * bw + bw / 2} y={h + 12} textAnchor="middle">{d.label.slice(5)}</text>}</g>; })}
    </svg>
  );
}
