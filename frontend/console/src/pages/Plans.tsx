import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/endpoints';
import type { Plan } from '../api/types';
import { useAuth } from '../contexts/AuthContext';
import { useAsync, useForm, useRun, useTenantNames } from '../lib/hooks';
import { can } from '../lib/perm';
import { day, money, num, paiseToRupees, rupeesToPaise } from '../lib/format';
import { Badge, DataTable, ErrorBox, Field, Icon, Loading, Modal, PageHeader, TableCard } from '../components/ui';

export default function Plans() {
  const { user } = useAuth(); const admin = can.admin(user?.role); const manage = can.manageTenants(user?.role);
  const { data, loading, error, reload } = useAsync(() => api.plans(), []);
  const reqs = useAsync(() => api.planRequests('pending'), []);
  const names = useTenantNames(); const { run, busy } = useRun();
  const [edit, setEdit] = useState<Plan | 'new' | null>(null);
  const plans = data?.data || []; const pname = (id: number) => plans.find((p) => p.id === id)?.name || `#${id}`;
  const decide = async (id: number, approve: boolean) => { if (await run(() => api.decidePlanRequest(id, approve), approve ? 'Request approved and plan changed' : 'Request rejected') !== undefined) reqs.reload(); };
  return (
    <>
      <PageHeader title="Plans" sub="Pricing and limits. Meta conversation charges are billed by Meta directly to each customer.">
        {admin && <button className="btn primary" onClick={() => setEdit('new')}><Icon name="plus" />New plan</button>}
      </PageHeader>
      {(reqs.data?.data || []).length > 0 && (
        <TableCard title="Plan change requests">
          <DataTable rows={reqs.data!.data} cols={[{ header: 'Customer', render: (r) => <Link to={`/tenants/${r.tenant_id}`}>{names[r.tenant_id] || `#${r.tenant_id}`}</Link> }, { header: 'Requested plan', render: (r) => <b>{pname(r.plan_id)}</b> }, { header: 'Note', render: (r) => r.note || '—' }, { header: 'Date', render: (r) => day(r.created_at) }, { header: '', render: (r) => manage && <span className="row"><button className="btn sm primary" disabled={busy} onClick={() => decide(r.id, true)}>Approve</button><button className="btn sm" disabled={busy} onClick={() => decide(r.id, false)}>Reject</button></span> }]} />
        </TableCard>
      )}
      {error && <ErrorBox error={error} onRetry={reload} />}
      <TableCard>
        {loading ? <Loading /> : (
          <DataTable<Plan> rows={plans} onRowClick={admin ? setEdit : undefined} cols={[
            { header: 'Plan', render: (p) => <span><b>{p.name}</b> <span className="muted mono">{p.code}</span></span> },
            { header: 'Price / month', className: 'right', render: (p) => money(p.price_paise) },
            { header: 'Included msgs', className: 'right', render: (p) => num(p.included_msgs) },
            { header: 'Extra msg fee', className: 'right', render: (p) => money(p.fee_per_msg_paise) },
            { header: 'Hard cap', className: 'right', render: (p) => (p.monthly_msg_cap ? num(p.monthly_msg_cap) : 'None') },
            { header: 'Numbers / keys / hooks', render: (p) => `${p.max_numbers} / ${p.max_api_keys} / ${p.max_webhooks}` },
            { header: 'Req/sec', className: 'right', render: (p) => p.rate_per_sec },
            { header: 'Visibility', render: (p) => <span className="row">{p.is_public ? <Badge kind="info">public</Badge> : <Badge>private</Badge>}{!p.is_active && <Badge kind="bad">inactive</Badge>}</span> },
          ]} />
        )}
      </TableCard>
      {edit && <PlanForm plan={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
    </>
  );
}

function PlanForm({ plan, onClose, onDone }: { plan: Plan | null; onClose: () => void; onDone: () => void }) {
  const { v, set } = useForm({
    code: plan?.code || '', name: plan?.name || '', description: plan?.description || '', price: paiseToRupees(plan?.price_paise || 0), fee: paiseToRupees(plan?.fee_per_msg_paise || 0),
    included_msgs: String(plan?.included_msgs ?? 0), monthly_msg_cap: String(plan?.monthly_msg_cap ?? 0), max_numbers: String(plan?.max_numbers ?? 1), max_api_keys: String(plan?.max_api_keys ?? 3),
    max_webhooks: String(plan?.max_webhooks ?? 2), rate_per_sec: String(plan?.rate_per_sec ?? 10), is_public: plan ? !!plan.is_public : true, is_active: plan ? !!plan.is_active : true,
  });
  const { run, busy } = useRun();
  const save = async () => {
    const body: Record<string, unknown> = {
      name: v.name.trim(), description: v.description.trim(), price_paise: rupeesToPaise(v.price), fee_per_msg_paise: rupeesToPaise(v.fee), included_msgs: +v.included_msgs, monthly_msg_cap: +v.monthly_msg_cap,
      max_numbers: +v.max_numbers, max_api_keys: +v.max_api_keys, max_webhooks: +v.max_webhooks, rate_per_sec: +v.rate_per_sec, is_public: v.is_public, is_active: v.is_active,
    };
    const r = plan ? await run(() => api.updatePlan(plan.id, body), 'Plan updated') : await run(() => api.createPlan({ ...body, code: v.code.trim() }), 'Plan created');
    if (r !== undefined) onDone();
  };
  const valid = v.name.trim().length > 0 && (plan || /^[a-z0-9_-]+$/.test(v.code));
  return (
    <Modal wide title={plan ? `Edit ${plan.name}` : 'New plan'} onClose={onClose} busy={busy} footer={<><button className="btn" onClick={onClose} disabled={busy}>Cancel</button><button className="btn primary" onClick={save} disabled={!valid || busy}>Save plan</button></>}>
      <div className="grid g2">
        {!plan && <Field label="Code" hint="Lowercase letters, numbers, - or _. Cannot be changed later."><input className="input mono" value={v.code} onChange={set('code')} /></Field>}
        <Field label="Name"><input className="input" value={v.name} onChange={set('name')} /></Field>
        <Field label="Monthly price (₹)"><input className="input" inputMode="decimal" value={v.price} onChange={set('price')} /></Field>
        <Field label="Fee per extra message (₹)" hint="Charged for messages beyond the included amount."><input className="input" inputMode="decimal" value={v.fee} onChange={set('fee')} /></Field>
        <Field label="Included messages / month"><input className="input" inputMode="numeric" value={v.included_msgs} onChange={set('included_msgs')} /></Field>
        <Field label="Hard monthly cap" hint="0 means unlimited."><input className="input" inputMode="numeric" value={v.monthly_msg_cap} onChange={set('monthly_msg_cap')} /></Field>
        <Field label="Max WhatsApp numbers"><input className="input" inputMode="numeric" value={v.max_numbers} onChange={set('max_numbers')} /></Field>
        <Field label="Max API keys"><input className="input" inputMode="numeric" value={v.max_api_keys} onChange={set('max_api_keys')} /></Field>
        <Field label="Max webhook endpoints"><input className="input" inputMode="numeric" value={v.max_webhooks} onChange={set('max_webhooks')} /></Field>
        <Field label="API requests per second"><input className="input" inputMode="numeric" value={v.rate_per_sec} onChange={set('rate_per_sec')} /></Field>
      </div>
      <Field label="Description"><input className="input" value={v.description} onChange={set('description')} /></Field>
      <div className="row"><label className="check"><input type="checkbox" checked={v.is_public} onChange={set('is_public')} />Visible to customers</label><label className="check"><input type="checkbox" checked={v.is_active} onChange={set('is_active')} />Active</label></div>
    </Modal>
  );
}
