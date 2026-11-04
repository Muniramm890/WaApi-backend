import { Link } from 'react-router-dom';
import { api } from '../api/endpoints';
import { useAsync, useTenantNames } from '../lib/hooks';
import { money, num } from '../lib/format';
import { Alert, Card, DataTable, ErrorBox, Loading, PageHeader, Stat, TableCard } from '../components/ui';

export default function Dashboard() {
  const { data: s, loading, error, reload } = useAsync(() => api.stats(), []);
  const names = useTenantNames();
  if (loading && !s) return <Loading />;
  if (error && !s) return <ErrorBox error={error} onRetry={reload} />;
  if (!s) return null;
  const t = s.tenants; const m = s.messages_24h; const failRate = m.out ? Math.round((m.failed / m.out) * 1000) / 10 : 0;
  const inboxErr = s.webhook_inbox.error || 0; const failedDel = s.webhook_deliveries.failed || 0;
  const alerts: { text: string; to: string; kind: 'warn' | 'bad' }[] = [];
  if (t.pending) alerts.push({ text: `${t.pending} customer${t.pending > 1 ? 's' : ''} waiting for approval`, to: '/tenants?status=pending', kind: 'warn' });
  if (s.wabas_invalid_token) alerts.push({ text: `${s.wabas_invalid_token} WhatsApp account${s.wabas_invalid_token > 1 ? 's have' : ' has'} an invalid access token`, to: '/health', kind: 'bad' });
  if (s.numbers_low_quality) alerts.push({ text: `${s.numbers_low_quality} number${s.numbers_low_quality > 1 ? 's have' : ' has'} low quality rating`, to: '/health', kind: 'warn' });
  if (inboxErr) alerts.push({ text: `${inboxErr} webhook event${inboxErr > 1 ? 's' : ''} failed processing`, to: '/webhooks', kind: 'bad' });
  if (failedDel) alerts.push({ text: `${failedDel} customer webhook deliver${failedDel > 1 ? 'ies' : 'y'} failed`, to: '/webhooks', kind: 'warn' });
  if (s.invoices_outstanding.count) alerts.push({ text: `${s.invoices_outstanding.count} unpaid invoice${s.invoices_outstanding.count > 1 ? 's' : ''} (${money(s.invoices_outstanding.due_paise)})`, to: '/billing', kind: 'warn' });
  return (
    <>
      <PageHeader title="Dashboard" sub="Live overview of customers, WhatsApp traffic and platform health."><button className="btn" onClick={reload}>Refresh</button></PageHeader>
      {alerts.length === 0 ? <Alert>All systems look healthy. Nothing needs your attention.</Alert> : alerts.map((a) => <Alert key={a.text} kind={a.kind}><Link to={a.to}>{a.text}</Link></Alert>)}
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Stat k="Active customers" v={num(t.active || 0)} s={`${num(t.pending || 0)} pending · ${num(t.suspended || 0)} suspended`} />
        <Stat k="Sent (24h)" v={num(m.out)} s={`${num(m.in)} received`} />
        <Stat k="Failed (24h)" v={num(m.failed)} s={`${failRate}% failure rate`} />
        <Stat k="Outstanding" v={money(s.invoices_outstanding.due_paise)} s={`${s.invoices_outstanding.count} invoice(s)`} />
      </div>
      <div className="grid g2">
        <Card title="Webhook pipeline">
          <div className="grid g2">
            <Stat k="Inbox pending" v={num(s.webhook_inbox.pending || 0)} s={`${num(inboxErr)} errors`} />
            <Stat k="Deliveries pending" v={num(s.webhook_deliveries.pending || 0)} s={`${num(failedDel)} failed`} />
          </div>
        </Card>
        <TableCard title="Top customers this month">
          <DataTable rows={s.top_tenants_this_month.map((r) => ({ id: r.tenant_id, n: r.n }))} empty="No traffic yet this month."
            cols={[{ header: 'Customer', render: (r) => <Link to={`/tenants/${r.id}`}>{names[r.id] || `#${r.id}`}</Link> }, { header: 'Messages sent', className: 'right', render: (r) => num(r.n) }]} />
        </TableCard>
      </div>
    </>
  );
}
