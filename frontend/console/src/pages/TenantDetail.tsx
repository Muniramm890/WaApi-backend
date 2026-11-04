import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/endpoints';
import type { Tenant, TenantDetail as TD, Waba } from '../api/types';
import { useAuth } from '../contexts/AuthContext';
import { useDialog } from '../contexts/DialogContext';
import { useAsync, useForm, usePlans, useRun, resetTenantNames } from '../lib/hooks';
import { can } from '../lib/perm';
import { ago, day, dt, money, monthStart, num, title, today } from '../lib/format';
import { MessagesPanel } from '../components/MessagesPanel';
import { Alert, BarChart, Badge, Card, DataTable, ErrorBox, Field, Icon, KV, Loading, Modal, PageHeader, Progress, Select, Stat, StatusBadge, TableCard, Tabs } from '../components/ui';

type Tab = 'overview' | 'usage' | 'users' | 'keys' | 'whatsapp' | 'messages';

export default function TenantDetail() {
  const id = Number(useParams().id); const nav = useNavigate();
  const { user } = useAuth(); const dialog = useDialog(); const { run, busy } = useRun();
  const { data, loading, error, reload } = useAsync(() => api.tenant(id), [id]);
  const [tab, setTab] = useState<Tab>('overview');
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;
  const t = data.tenant; const manage = can.manageTenants(user?.role);
  const after = (m: string, fn: () => Promise<unknown>) => async () => { await run(fn, m); resetTenantNames(); reload(); };
  const suspend = async () => {
    const reason = await dialog.prompt({ title: 'Suspend customer', message: 'Suspended customers cannot send messages or create API keys. Their data is kept.', label: 'Reason (visible to the customer)', required: true, multiline: true, confirmText: 'Suspend', danger: true });
    if (reason) await after('Customer suspended', () => api.suspendTenant(id, reason))();
  };
  const del = async () => {
    if (await dialog.confirm({ title: 'Delete customer', danger: true, confirmText: 'Delete customer', message: <>This disconnects every WhatsApp account, revokes all API keys and disables all users of <b>{t.name}</b>. This cannot be undone.</> })) {
      await run(() => api.deleteTenant(id), 'Customer deleted'); resetTenantNames(); nav('/tenants');
    }
  };
  return (
    <>
      <PageHeader title={t.name} sub={<span><Link to="/tenants">Customers</Link> / #{t.id} · <StatusBadge status={t.status} /> · {title(t.kind)}</span>}>
        {manage && t.status === 'pending' && <button className="btn primary" disabled={busy} onClick={after('Customer approved', () => api.approveTenant(id))}>Approve</button>}
        {manage && t.status === 'active' && <button className="btn" disabled={busy} onClick={suspend}>Suspend</button>}
        {manage && t.status === 'suspended' && <button className="btn primary" disabled={busy} onClick={after('Customer reactivated', () => api.activateTenant(id))}>Reactivate</button>}
        {can.deleteTenant(user?.role) && t.status !== 'deleted' && <button className="btn danger" disabled={busy} onClick={del}>Delete</button>}
      </PageHeader>
      {t.status === 'suspended' && <Alert kind="warn">Suspended: {t.suspended_reason || 'no reason recorded'}</Alert>}
      {t.status === 'pending' && <Alert>This customer registered themselves and is waiting for approval.</Alert>}
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: 'overview', label: 'Overview' }, { id: 'usage', label: 'Usage' }, { id: 'users', label: `Users (${data.counts.users})` }, { id: 'keys', label: `API keys (${data.counts.api_keys})` }, { id: 'whatsapp', label: `WhatsApp (${data.counts.wabas})` }, { id: 'messages', label: 'Messages' }]} />
      {tab === 'overview' && <Overview d={data} manage={manage} reload={() => { resetTenantNames(); reload(); }} />}
      {tab === 'usage' && <UsageTab id={id} />}
      {tab === 'users' && <UsersTab id={id} />}
      {tab === 'keys' && <KeysTab id={id} manage={manage} onChanged={reload} />}
      {tab === 'whatsapp' && <WhatsAppTab id={id} manage={manage} onChanged={reload} />}
      {tab === 'messages' && <MessagesPanel tenantId={id} />}
    </>
  );
}

function Overview({ d, manage, reload }: { d: TD; manage: boolean; reload: () => void }) {
  const t = d.tenant; const o = d.overview; const { plans } = usePlans(); const { run, busy } = useRun();
  const [planId, setPlanId] = useState(String(t.plan_id ?? d.plan.id ?? '')); const [editing, setEditing] = useState(false);
  const cap = o.monthly_cap || 0;
  return (
    <>
      <div className="grid g2">
        <Card title="Plan & usage" actions={manage && <span className="row"><Select value={planId} onChange={setPlanId} options={plans.map((p) => ({ value: String(p.id), label: `${p.name} · ${money(p.price_paise)}` }))} /><button className="btn sm primary" disabled={busy || planId === String(t.plan_id ?? d.plan.id)} onClick={async () => { if (await run(() => api.setTenantPlan(t.id, Number(planId)), 'Plan updated') !== undefined) reload(); }}>Change</button></span>}>
          <KV rows={[['Current plan', <b>{o.plan.name}</b>], ['Monthly fee', money(o.plan.price_paise)], ['Rate limit', `${o.plan.rate_per_sec} requests/sec`]]} />
          <div style={{ marginTop: 14 }}><div className="row" style={{ justifyContent: 'space-between' }}><span>Messages this month</span><b>{num(o.sent_this_period)}{cap ? ` / ${num(cap)}` : ''}</b></div><Progress value={o.sent_this_period} max={cap || Math.max(o.included, 1)} /><div className="hint">{num(o.included)} included · {num(o.overage_msgs)} over included{cap ? ' · hard cap applies' : ''}</div></div>
          <div className="grid g3" style={{ marginTop: 14 }}>
            <Stat k="Numbers" v={`${o.numbers_used}/${o.plan.max_numbers}`} /><Stat k="API keys" v={`${o.api_keys_used}/${o.plan.max_api_keys}`} /><Stat k="Webhooks" v={`${o.webhooks_used}/${o.plan.max_webhooks}`} />
          </div>
        </Card>
        <Card title="Profile" actions={manage && <button className="btn sm" onClick={() => setEditing(true)}>Edit</button>}>
          <KV rows={[['Email', t.contact_email], ['Phone', t.contact_phone], ['Country', t.country], ['Timezone', t.timezone], ['Website', t.website], ['GSTIN', t.gstin], ['Address', t.address], ['External reference', t.external_ref && <span className="mono">{t.external_ref}</span>], ['Joined', dt(t.created_at)], ['Approved templates', d.counts.templates], ['Unpaid invoices', d.counts.unpaid_invoices]]} />
        </Card>
      </div>
      {editing && <EditTenant t={t} onClose={() => setEditing(false)} onDone={() => { setEditing(false); reload(); }} />}
    </>
  );
}

function EditTenant({ t, onClose, onDone }: { t: Tenant; onClose: () => void; onDone: () => void }) {
  const { v, set } = useForm({ name: t.name, kind: t.kind, contact_email: t.contact_email || '', contact_phone: t.contact_phone || '', country: t.country || '', timezone: t.timezone || '', website: t.website || '', gstin: t.gstin || '', address: t.address || '', external_ref: t.external_ref || '' });
  const { run, busy } = useRun();
  const save = async () => {
    const body: Record<string, string> = {}; for (const [k, val] of Object.entries(v)) if (String(val).trim() !== '') body[k] = String(val).trim();
    if (await run(() => api.updateTenant(t.id, body), 'Customer updated') !== undefined) onDone();
  };
  return (
    <Modal title="Edit customer" onClose={onClose} busy={busy} footer={<><button className="btn" onClick={onClose} disabled={busy}>Cancel</button><button className="btn primary" onClick={save} disabled={busy || v.name.trim().length < 2}>Save changes</button></>}>
      <Field label="Name"><input className="input" value={v.name} onChange={set('name')} /></Field>
      <Field label="Type"><Select value={v.kind} onChange={set('kind')} options={['school', 'business', 'reseller', 'other']} /></Field>
      <Field label="Email"><input className="input" value={v.contact_email} onChange={set('contact_email')} /></Field>
      <Field label="Phone"><input className="input" value={v.contact_phone} onChange={set('contact_phone')} /></Field>
      <div className="row"><Field label="Country (2 letters)"><input className="input" maxLength={2} value={v.country} onChange={set('country')} /></Field><Field label="Timezone"><input className="input" value={v.timezone} onChange={set('timezone')} placeholder="Asia/Kolkata" /></Field></div>
      <Field label="Website"><input className="input" value={v.website} onChange={set('website')} /></Field>
      <Field label="GSTIN"><input className="input" value={v.gstin} onChange={set('gstin')} /></Field>
      <Field label="Address"><textarea className="textarea" value={v.address} onChange={set('address')} /></Field>
      <Field label="External reference" hint="Optional link to your own system, e.g. the School ERP school id. Must be unique."><input className="input" value={v.external_ref} onChange={set('external_ref')} /></Field>
    </Modal>
  );
}

function UsageTab({ id }: { id: number }) {
  const [from, setFrom] = useState(monthStart()); const [to, setTo] = useState(today());
  const { data, loading, error, reload } = useAsync(() => api.tenantUsage(id, from, to), [id, from, to]);
  const perDay: Record<string, number> = {}; for (const r of data?.daily || []) perDay[r.day] = (perDay[r.day] || 0) + r.sent;
  const T = data?.totals;
  return (
    <>
      <div className="filters"><Field label="From"><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="To"><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field><button className="btn" onClick={reload}>Refresh</button></div>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && !data ? <Loading /> : T && (
        <>
          <div className="grid g4" style={{ marginBottom: 16 }}><Stat k="Sent" v={num(T.sent)} /><Stat k="Delivered" v={num(T.delivered)} /><Stat k="Read" v={num(T.read)} /><Stat k="Failed" v={num(T.failed)} s={`${num(T.inbound)} inbound`} /></div>
          <Card title="Messages sent per day"><BarChart data={Object.entries(perDay).sort().map(([label, value]) => ({ label, value }))} /></Card>
          <TableCard title="By category"><DataTable rows={Object.entries(data!.by_category).map(([k, c]) => ({ id: k, k, sent: c.sent || 0, delivered: c.delivered || 0, read: c.read || 0, failed: c.failed || 0, inbound: c.inbound || 0 }))} empty="No usage in this period." cols={[{ header: 'Category', render: (r) => title(r.k) }, { header: 'Sent', className: 'right', render: (r) => num(r.sent) }, { header: 'Delivered', className: 'right', render: (r) => num(r.delivered) }, { header: 'Read', className: 'right', render: (r) => num(r.read) }, { header: 'Failed', className: 'right', render: (r) => num(r.failed) }, { header: 'Inbound', className: 'right', render: (r) => num(r.inbound) }]} /></TableCard>
        </>
      )}
    </>
  );
}

function UsersTab({ id }: { id: number }) {
  const { data, loading, error, reload } = useAsync(() => api.tenantUsers(id), [id]);
  if (loading && !data) return <Loading />;
  return <>{error && <ErrorBox error={error} onRetry={reload} />}<TableCard><DataTable rows={data?.data || []} empty="No users." cols={[{ header: 'Name', render: (u) => <b>{u.name}</b> }, { header: 'Email', render: (u) => u.email }, { header: 'Role', render: (u) => title(u.role) }, { header: 'Status', render: (u) => <StatusBadge status={u.status} /> }, { header: 'Email verified', render: (u) => (u.email_verified ? 'Yes' : 'No') }, { header: 'Last login', render: (u) => ago(u.last_login_at) }]} /></TableCard></>;
}

function KeysTab({ id, manage, onChanged }: { id: number; manage: boolean; onChanged: () => void }) {
  const { data, loading, error, reload } = useAsync(() => api.tenantKeys(id), [id]);
  const dialog = useDialog(); const { run } = useRun();
  if (loading && !data) return <Loading />;
  const revoke = async (kid: number, name: string) => {
    if (await dialog.confirm({ title: 'Revoke API key', danger: true, confirmText: 'Revoke key', message: <>Revoke <b>{name}</b>? Applications using it will stop working immediately.</> })) { if (await run(() => api.revokeKey(id, kid), 'API key revoked') !== undefined) { reload(); onChanged(); } }
  };
  return <>{error && <ErrorBox error={error} onRetry={reload} />}<TableCard><DataTable rows={data?.data || []} empty="This customer has no API keys." cols={[{ header: 'Name', render: (k) => <b>{k.name}</b> }, { header: 'Key', render: (k) => <span className="mono">{k.prefix}</span> }, { header: 'Scopes', render: (k) => k.scopes.length + ' scopes' }, { header: 'Status', render: (k) => <StatusBadge status={k.status} /> }, { header: 'Last used', render: (k) => ago(k.last_used_at) }, { header: '', render: (k) => manage && k.status === 'active' ? <button className="btn sm danger" onClick={() => revoke(k.id, k.name)}>Revoke</button> : null }]} /></TableCard></>;
}

function WhatsAppTab({ id, manage, onChanged }: { id: number; manage: boolean; onChanged: () => void }) {
  const { data, loading, error, reload } = useAsync(() => api.tenantWabas(id), [id]);
  const dialog = useDialog(); const { run, busy } = useRun(); const [attach, setAttach] = useState(false);
  if (loading && !data) return <Loading />;
  const sync = async (w: Waba) => { if (await run(() => api.syncWaba(w.id), 'Account synced with Meta') !== undefined) reload(); };
  const disconnect = async (w: Waba) => {
    if (await dialog.confirm({ title: 'Disconnect WhatsApp account', danger: true, confirmText: 'Disconnect', message: <>Disconnect <b>{w.name || w.waba_id}</b>? The stored access token is deleted and messaging stops until the customer reconnects.</> })) { if (await run(() => api.disconnectWaba(w.id), 'Account disconnected') !== undefined) { reload(); onChanged(); } }
  };
  return (
    <>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {manage && <div className="row" style={{ marginBottom: 14 }}><button className="btn primary" onClick={() => setAttach(true)}><Icon name="plus" />Attach existing WABA</button></div>}
      {(data?.data || []).length === 0 && <Card><div className="empty">No WhatsApp accounts connected. The customer connects from their portal, or you can attach an existing WABA.</div></Card>}
      {(data?.data || []).map((w) => (
        <Card key={w.id} title={<span>{w.name || 'WhatsApp Business Account'} <span className="muted mono">{w.waba_id}</span></span>} actions={manage && w.status === 'active' && <><button className="btn sm" disabled={busy} onClick={() => sync(w)}><Icon name="refresh" />Sync</button><button className="btn sm danger" disabled={busy} onClick={() => disconnect(w)}>Disconnect</button></>}>
          <div className="row" style={{ marginBottom: 10 }}><StatusBadge status={w.status} /><Badge kind={w.token_valid ? 'ok' : 'bad'}>{w.token_valid ? 'Token valid' : 'Token invalid'}</Badge><Badge kind={w.subscribed ? 'ok' : 'warn'}>{w.subscribed ? 'Webhooks subscribed' : 'Not subscribed'}</Badge>{w.review_status && <Badge>{`Review: ${w.review_status}`}</Badge>}<span className="muted">Synced {ago(w.last_synced_at)}</span></div>
          {w.last_error && <Alert kind="bad">{w.last_error}</Alert>}
          <div className="table-wrap"><DataTable rows={w.numbers || []} empty="No numbers." cols={[{ header: 'Number', render: (n) => <span><b>{n.display_phone || '—'}</b>{n.is_default && <> <Badge kind="info">default</Badge></>}</span> }, { header: 'Display name', render: (n) => n.verified_name || '—' }, { header: 'Quality', render: (n) => <StatusBadge status={n.quality_rating} /> }, { header: 'Tier', render: (n) => n.messaging_tier || '—' }, { header: 'Status', render: (n) => <StatusBadge status={n.status} /> }, { header: 'Registered', render: (n) => (n.registered ? 'Yes' : <span title={n.register_error || ''}>No</span>) }]} /></div>
        </Card>
      ))}
      {attach && <AttachWaba id={id} onClose={() => setAttach(false)} onDone={() => { setAttach(false); reload(); onChanged(); }} />}
    </>
  );
}

function AttachWaba({ id, onClose, onDone }: { id: number; onClose: () => void; onDone: () => void }) {
  const { v, set } = useForm({ waba_id: '', access_token: '' }); const { run, busy } = useRun();
  const ok = /^\d{5,25}$/.test(v.waba_id.trim());
  return (
    <Modal title="Attach existing WABA" onClose={onClose} busy={busy} footer={<><button className="btn" onClick={onClose} disabled={busy}>Cancel</button><button className="btn primary" disabled={!ok || busy} onClick={async () => { if (await run(() => api.attachWaba(id, v.waba_id.trim(), v.access_token.trim()), 'WhatsApp account attached') !== undefined) onDone(); }}>Attach account</button></>}>
      <Alert>Use this to move an existing WhatsApp Business Account under this customer, for example numbers already managed with your platform system-user token.</Alert>
      <Field label="WhatsApp Business Account ID"><input className="input mono" inputMode="numeric" value={v.waba_id} onChange={set('waba_id')} autoFocus /></Field>
      <Field label="Access token (optional)" hint="Leave empty to use the platform system-user token configured on the server."><textarea className="textarea mono" value={v.access_token} onChange={set('access_token')} /></Field>
    </Modal>
  );
}
