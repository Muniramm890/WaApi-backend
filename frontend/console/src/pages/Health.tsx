import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/endpoints';
import type { PhoneNumber, Waba } from '../api/types';
import { useAuth } from '../contexts/AuthContext';
import { useDialog } from '../contexts/DialogContext';
import { useAsync, useRun, useTenantNames } from '../lib/hooks';
import { can } from '../lib/perm';
import { ago } from '../lib/format';
import { Badge, DataTable, ErrorBox, Field, Icon, Loading, PageHeader, Select, StatusBadge, TableCard, Tabs } from '../components/ui';

export default function Health() {
  const [tab, setTab] = useState<'numbers' | 'wabas'>('numbers');
  return (
    <>
      <PageHeader title="WhatsApp health" sub="Number quality, messaging limits and connection state across all customers." />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'numbers', label: 'Phone numbers' }, { id: 'wabas', label: 'WhatsApp accounts' }]} />
      {tab === 'numbers' ? <Numbers /> : <Wabas />}
    </>
  );
}

function Numbers() {
  const [quality, setQuality] = useState(''); const [status, setStatus] = useState(''); const names = useTenantNames();
  const { data, loading, error, reload } = useAsync(() => api.numbers({ quality: quality || undefined, status: status || undefined }), [quality, status]);
  return (
    <>
      <div className="filters"><Field label="Quality"><Select value={quality} onChange={setQuality} placeholder="Any" options={['GREEN', 'YELLOW', 'RED', 'UNKNOWN']} /></Field><Field label="Status"><Select value={status} onChange={setStatus} placeholder="Any" options={['CONNECTED', 'PENDING', 'DISCONNECTED', 'FLAGGED', 'RESTRICTED']} /></Field><button className="btn" onClick={reload}>Refresh</button></div>
      {error && <ErrorBox error={error} onRetry={reload} />}
      <TableCard>{loading ? <Loading /> : (
        <DataTable<PhoneNumber> rows={data?.data || []} empty="No numbers match." cols={[
          { header: 'Number', render: (n) => <b>{n.display_phone || n.phone_number_id}</b> },
          { header: 'Customer', render: (n) => <Link to={`/tenants/${n.tenant_id}`}>{names[n.tenant_id as number] || `#${n.tenant_id}`}</Link> },
          { header: 'Display name', render: (n) => n.verified_name || '—' },
          { header: 'Quality', render: (n) => <StatusBadge status={n.quality_rating} /> },
          { header: 'Tier', render: (n) => n.messaging_tier || '—' },
          { header: 'Status', render: (n) => <StatusBadge status={n.status} /> },
          { header: 'Name status', render: (n) => n.name_status || '—' },
          { header: 'Registered', render: (n) => (n.registered ? 'Yes' : <span title={n.register_error || ''}><Badge kind="warn">No</Badge></span>) },
        ]} />
      )}</TableCard>
    </>
  );
}

function Wabas() {
  const { user } = useAuth(); const manage = can.manageTenants(user?.role); const dialog = useDialog(); const { run, busy } = useRun(); const names = useTenantNames();
  const [bad, setBad] = useState(false); const [status, setStatus] = useState('');
  const { data, loading, error, reload } = useAsync(() => api.wabas({ token_valid: bad ? '0' : undefined, status: status || undefined }), [bad, status]);
  const sync = async (w: Waba) => { if (await run(() => api.syncWaba(w.id), 'Account synced') !== undefined) reload(); };
  const disconnect = async (w: Waba) => { if (await dialog.confirm({ title: 'Disconnect account', danger: true, confirmText: 'Disconnect', message: `Disconnect ${w.name || w.waba_id}? Messaging stops until the customer reconnects.` })) { if (await run(() => api.disconnectWaba(w.id), 'Disconnected') !== undefined) reload(); } };
  return (
    <>
      <div className="filters"><Field label="Status"><Select value={status} onChange={setStatus} placeholder="Any" options={['active', 'disconnected']} /></Field><label className="check" style={{ minHeight: 40 }}><input type="checkbox" checked={bad} onChange={(e) => setBad(e.target.checked)} />Invalid token only</label><button className="btn" onClick={reload}>Refresh</button></div>
      {error && <ErrorBox error={error} onRetry={reload} />}
      <TableCard>{loading ? <Loading /> : (
        <DataTable<Waba> rows={data?.data || []} empty="No accounts match." cols={[
          { header: 'Account', render: (w) => <span><b>{w.name || '—'}</b><br /><span className="muted mono">{w.waba_id}</span></span> },
          { header: 'Customer', render: (w) => <Link to={`/tenants/${w.tenant_id}`}>{names[w.tenant_id] || `#${w.tenant_id}`}</Link> },
          { header: 'Status', render: (w) => <StatusBadge status={w.status} /> },
          { header: 'Token', render: (w) => <Badge kind={w.token_valid ? 'ok' : 'bad'}>{w.token_valid ? 'Valid' : 'Invalid'}</Badge> },
          { header: 'Webhooks', render: (w) => <Badge kind={w.subscribed ? 'ok' : 'warn'}>{w.subscribed ? 'Subscribed' : 'No'}</Badge> },
          { header: 'Review', render: (w) => w.review_status || '—' },
          { header: 'Synced', render: (w) => ago(w.last_synced_at) },
          { header: '', render: (w) => manage && w.status === 'active' && <span className="row"><button className="btn sm" disabled={busy} onClick={() => sync(w)}><Icon name="refresh" />Sync</button><button className="btn sm danger" disabled={busy} onClick={() => disconnect(w)}>Disconnect</button></span> },
        ]} />
      )}</TableCard>
    </>
  );
}
