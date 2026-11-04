import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/endpoints';
import { useAuth } from '../contexts/AuthContext';
import { useDialog } from '../contexts/DialogContext';
import { useCursorList, useRun, useTenantNames } from '../lib/hooks';
import { can } from '../lib/perm';
import { dt, safeJson } from '../lib/format';
import { DataTable, ErrorBox, Field, JsonView, LoadMore, Loading, Modal, PageHeader, Select, StatusBadge, TableCard, Tabs } from '../components/ui';

type Tab = 'inbox' | 'deliveries' | 'events';

export default function Webhooks() {
  const [tab, setTab] = useState<Tab>('inbox');
  return (
    <>
      <PageHeader title="Webhooks" sub="Incoming events from Meta, deliveries to customer endpoints, and the raw event audit trail." />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: 'inbox', label: 'Meta inbox' }, { id: 'deliveries', label: 'Customer deliveries' }, { id: 'events', label: 'Meta events' }]} />
      {tab === 'inbox' && <Inbox />}{tab === 'deliveries' && <Deliveries />}{tab === 'events' && <Events />}
    </>
  );
}

function Inbox() {
  const { user } = useAuth(); const manage = can.manageTenants(user?.role); const dialog = useDialog(); const { run, busy } = useRun();
  const [state, setState] = useState('error'); const [sel, setSel] = useState<Set<number>>(new Set()); const [view, setView] = useState<any>(null);
  const list = useCursorList<any>(async (before) => (await api.inbox({ state, before })).data, [state]);
  const toggle = (id: number) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const open = async (id: number) => { const r = await run(() => api.inboxItem(id)); if (r) setView(r); };
  const reprocess = async (ids?: number[]) => {
    const all = !ids;
    if (all && !(await dialog.confirm({ title: 'Reprocess all', message: `Re-queue every "${state}" event for processing? Processing is idempotent, so duplicates are safe.`, confirmText: 'Reprocess' }))) return;
    const r = await run(() => api.reprocess(all ? { state } : { ids })); if (r) { await dialog.alert({ title: 'Re-queued', message: `${r.requeued} event(s) were queued for reprocessing.` }); setSel(new Set()); list.reload(); }
  };
  return (
    <>
      <div className="filters"><Field label="State"><Select value={state} onChange={(v) => { setState(v); setSel(new Set()); }} options={['error', 'pending', 'done', 'skipped']} /></Field>
        <button className="btn" onClick={list.reload}>Refresh</button>
        {manage && <><button className="btn" disabled={busy || !sel.size} onClick={() => reprocess([...sel])}>Reprocess selected ({sel.size})</button><button className="btn" disabled={busy} onClick={() => reprocess()}>Reprocess all {state}</button></>}</div>
      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      <TableCard>{list.loading ? <Loading /> : (
        <DataTable rows={list.items} onRowClick={(r) => open(r.id)} selected={sel} onToggle={manage ? toggle : undefined} empty={`No ${state} events.`} cols={[
          { header: 'Received', render: (r) => <span className="nowrap">{dt(r.received_at)}</span> },
          { header: 'State', render: (r) => <StatusBadge status={r.state} /> },
          { header: 'Attempts', className: 'right', render: (r) => r.attempts },
          { header: 'Signature', render: (r) => (r.signature_ok ? 'Valid' : 'Invalid') },
          { header: 'Last error', render: (r) => <span className="muted">{r.last_error || '—'}</span> },
        ]} />
      )}<LoadMore more={list.more} loading={list.loadingMore} onClick={list.loadMore} /></TableCard>
      {view && <Modal wide title={`Webhook event #${view.id}`} onClose={() => setView(null)}><JsonView value={{ ...view, payload: safeJson(view.payload) }} /></Modal>}
    </>
  );
}

function Deliveries() {
  const names = useTenantNames(); const [state, setState] = useState('failed'); const [view, setView] = useState<any>(null);
  const list = useCursorList<any>(async (before) => (await api.deliveries({ state, before })).data, [state]);
  return (
    <>
      <div className="filters"><Field label="State"><Select value={state} onChange={setState} options={['failed', 'pending', 'delivered']} /></Field><button className="btn" onClick={list.reload}>Refresh</button></div>
      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      <TableCard>{list.loading ? <Loading /> : (
        <DataTable rows={list.items} onRowClick={setView} empty={`No ${state} deliveries.`} cols={[
          { header: 'Time', render: (r) => <span className="nowrap">{dt(r.created_at)}</span> },
          { header: 'Customer', render: (r) => <Link to={`/tenants/${r.tenant_id}`} onClick={(e) => e.stopPropagation()}>{names[r.tenant_id] || `#${r.tenant_id}`}</Link> },
          { header: 'Event', render: (r) => <span className="mono">{r.event_type}</span> },
          { header: 'State', render: (r) => <StatusBadge status={r.state} /> },
          { header: 'Attempts', className: 'right', render: (r) => r.attempts },
          { header: 'HTTP', render: (r) => r.last_status ?? '—' },
          { header: 'Error', render: (r) => <span className="muted">{r.last_error || '—'}</span> },
        ]} />
      )}<LoadMore more={list.more} loading={list.loadingMore} onClick={list.loadMore} /></TableCard>
      {view && <Modal title={`Delivery #${view.id}`} onClose={() => setView(null)}><JsonView value={view} /></Modal>}
    </>
  );
}

function Events() {
  const names = useTenantNames(); const [field, setField] = useState(''); const [tenant, setTenant] = useState('');
  const list = useCursorList<any>(async (before) => (await api.metaEvents({ field: field || undefined, tenant_id: tenant ? Number(tenant) : undefined, before })).data, [field, tenant]);
  return (
    <>
      <div className="filters"><Field label="Field"><Select value={field} onChange={setField} placeholder="All fields" options={['messages', 'message_template_status_update', 'message_template_quality_update', 'template_category_update', 'phone_number_quality_update', 'phone_number_name_update', 'account_update', 'account_review_update', 'account_alerts', 'business_capability_update']} /></Field>
        <Field label="Customer"><Select value={tenant} onChange={setTenant} placeholder="All" options={Object.entries(names).map(([id, n]) => ({ value: id, label: n }))} /></Field><button className="btn" onClick={list.reload}>Refresh</button></div>
      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      <TableCard>{list.loading ? <Loading /> : (
        <DataTable rows={list.items} empty="No events recorded." cols={[
          { header: 'Time', render: (r) => <span className="nowrap">{dt(r.created_at)}</span> },
          { header: 'Customer', render: (r) => (r.tenant_id ? names[r.tenant_id] || `#${r.tenant_id}` : '—') },
          { header: 'WABA', render: (r) => <span className="mono">{r.waba_id || '—'}</span> },
          { header: 'Field', render: (r) => <span className="mono">{r.field}</span> },
          { header: 'Event', render: (r) => r.event || '—' },
        ]} />
      )}<LoadMore more={list.more} loading={list.loadingMore} onClick={list.loadMore} /></TableCard>
    </>
  );
}
