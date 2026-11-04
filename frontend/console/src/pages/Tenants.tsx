import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/endpoints';
import type { Tenant } from '../api/types';
import { useAuth } from '../contexts/AuthContext';
import { useCursorList, useDebounce, useForm, usePlans, useRun, resetTenantNames } from '../lib/hooks';
import { can } from '../lib/perm';
import { day, title } from '../lib/format';
import { DataTable, ErrorBox, Field, Icon, LoadMore, Loading, Modal, PageHeader, Select, StatusBadge, TableCard } from '../components/ui';

export default function Tenants() {
  const { user } = useAuth(); const nav = useNavigate(); const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState(''); const dq = useDebounce(q); const status = sp.get('status') || '';
  const { byId, plans } = usePlans(); const [creating, setCreating] = useState(false);
  const list = useCursorList<Tenant>(async (before) => (await api.tenants({ q: dq || undefined, status: status || undefined, before })).data, [dq, status]);
  return (
    <>
      <PageHeader title="Customers" sub="Schools and businesses using the WhatsApp platform.">
        {can.manageTenants(user?.role) && <button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" />New customer</button>}
      </PageHeader>
      <div className="filters">
        <div className="field grow"><span className="label">Search</span><input className="input" placeholder="Name or email" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <Field label="Status"><Select value={status} onChange={(v) => setSp(v ? { status: v } : {})} placeholder="All" options={['pending', 'active', 'suspended', 'deleted']} /></Field>
      </div>
      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      <TableCard>
        {list.loading ? <Loading /> : (
          <DataTable<Tenant> rows={list.items} onRowClick={(t) => nav(`/tenants/${t.id}`)} empty="No customers found."
            cols={[
              { header: 'Name', render: (t) => <Link to={`/tenants/${t.id}`} onClick={(e) => e.stopPropagation()}><b>{t.name}</b></Link> },
              { header: 'Type', render: (t) => title(t.kind) },
              { header: 'Status', render: (t) => <StatusBadge status={t.status} /> },
              { header: 'Plan', render: (t) => (t.plan_id && byId[t.plan_id]?.name) || '—' },
              { header: 'Contact', render: (t) => t.contact_email || '—' },
              { header: 'Joined', render: (t) => <span className="nowrap">{day(t.created_at)}</span> },
            ]} />
        )}
        <LoadMore more={list.more} loading={list.loadingMore} onClick={list.loadMore} />
      </TableCard>
      {creating && <CreateTenant plans={plans} onClose={() => setCreating(false)} onDone={(id) => { resetTenantNames(); nav(`/tenants/${id}`); }} />}
    </>
  );
}

function CreateTenant({ plans, onClose, onDone }: { plans: { id: number; name: string }[]; onClose: () => void; onDone: (id: number) => void }) {
  const { v, set } = useForm({ business_name: '', owner_name: '', owner_email: '', kind: 'school', plan_id: '' });
  const { run, busy } = useRun();
  const submit = async () => {
    const r = await run(() => api.createTenant({ business_name: v.business_name.trim(), owner_name: v.owner_name.trim(), owner_email: v.owner_email.trim(), kind: v.kind, plan_id: v.plan_id ? Number(v.plan_id) : undefined }), 'Customer created. An invitation email was sent to the owner.');
    if (r) onDone(r.tenant_id);
  };
  const ok = v.business_name.trim().length >= 2 && v.owner_name.trim().length >= 2 && /\S+@\S+\.\S+/.test(v.owner_email);
  return (
    <Modal title="New customer" onClose={onClose} busy={busy} footer={<><button className="btn" onClick={onClose} disabled={busy}>Cancel</button><button className="btn primary" onClick={submit} disabled={!ok || busy}>Create customer</button></>}>
      <Field label="Business or school name"><input className="input" value={v.business_name} onChange={set('business_name')} autoFocus /></Field>
      <Field label="Type"><Select value={v.kind} onChange={set('kind')} options={['school', 'business', 'reseller', 'other']} /></Field>
      <Field label="Owner name"><input className="input" value={v.owner_name} onChange={set('owner_name')} /></Field>
      <Field label="Owner email" hint="The owner receives a link to set their password."><input className="input" type="email" value={v.owner_email} onChange={set('owner_email')} /></Field>
      <Field label="Plan"><Select value={v.plan_id} onChange={set('plan_id')} placeholder="Default (Sandbox)" options={plans.map((p) => ({ value: String(p.id), label: p.name }))} /></Field>
    </Modal>
  );
}
