import { useState } from 'react';
import { api } from '../api/endpoints';
import { useCursorList, useDebounce, useTenantNames } from '../lib/hooks';
import { dt, safeJson } from '../lib/format';
import { Badge, DataTable, ErrorBox, Field, JsonView, LoadMore, Loading, Modal, PageHeader, Select, TableCard } from '../components/ui';

export default function Audit() {
  const names = useTenantNames(); const [tenant, setTenant] = useState(''); const [action, setAction] = useState(''); const da = useDebounce(action); const [view, setView] = useState<any>(null);
  const list = useCursorList<any>(async (before) => (await api.audit({ tenant_id: tenant ? Number(tenant) : undefined, action: da.trim() || undefined, before })).data, [tenant, da]);
  return (
    <>
      <PageHeader title="Audit log" sub="Who did what, across staff, customers and API keys." />
      <div className="filters">
        <Field label="Customer"><Select value={tenant} onChange={setTenant} placeholder="All" options={Object.entries(names).map(([id, n]) => ({ value: id, label: n }))} /></Field>
        <div className="field grow"><span className="label">Action (exact)</span><input className="input" placeholder="e.g. tenant.suspend" value={action} onChange={(e) => setAction(e.target.value)} /></div>
        <button className="btn" onClick={list.reload}>Refresh</button>
      </div>
      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      <TableCard>{list.loading ? <Loading /> : (
        <DataTable rows={list.items} onRowClick={(r) => setView({ ...r, meta: safeJson(r.meta) })} empty="No audit entries." cols={[
          { header: 'Time', render: (r) => <span className="nowrap">{dt(r.created_at)}</span> },
          { header: 'Actor', render: (r) => <span><Badge>{r.actor_type}</Badge> {r.actor_label || ''}</span> },
          { header: 'Action', render: (r) => <span className="mono">{r.action}</span> },
          { header: 'Customer', render: (r) => (r.tenant_id ? names[r.tenant_id] || `#${r.tenant_id}` : '—') },
          { header: 'Target', render: (r) => (r.target_type ? `${r.target_type} ${r.target_id ?? ''}` : '—') },
          { header: 'IP', render: (r) => <span className="mono">{r.ip || '—'}</span> },
        ]} />
      )}<LoadMore more={list.more} loading={list.loadingMore} onClick={list.loadMore} /></TableCard>
      {view && <Modal title={`Audit entry #${view.id}`} wide onClose={() => setView(null)}><JsonView value={view} /></Modal>}
    </>
  );
}
