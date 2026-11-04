import { useEffect, useState } from 'react';
import { api } from '../api/endpoints';
import { useAuth } from '../contexts/AuthContext';
import { useDialog } from '../contexts/DialogContext';
import { useAsync, useForm, useRun } from '../lib/hooks';
import { can } from '../lib/perm';
import { Alert, Card, ErrorBox, Field, JsonView, Loading, Modal, PageHeader, Progress } from '../components/ui';

const JOBS: [string, string][] = [
  ['inbox', 'Retry stuck Meta webhook events'], ['deliveries', 'Send queued customer webhooks'], ['templates', 'Sync message templates from Meta'],
  ['health', 'Check WhatsApp tokens and numbers'], ['billing', 'Generate invoices and enforce overdue dues'], ['cleanup', 'Apply data-retention cleanup'],
];

export default function Settings() {
  const { user } = useAuth(); const admin = can.admin(user?.role); const dialog = useDialog(); const { run, busy } = useRun();
  const { data, loading, error, reload } = useAsync(() => api.settings(), []);
  const { v, setV, set } = useForm({ tax_percent: '', grace_days: '', invoice_due_days: '', invoice_prefix: '', signup_open: true });
  const [result, setResult] = useState<unknown>(null);
  useEffect(() => { if (data) setV({ tax_percent: data.tax_percent ?? '', grace_days: data.grace_days ?? '', invoice_due_days: data.invoice_due_days ?? '', invoice_prefix: data.invoice_prefix ?? '', signup_open: data.signup_open !== '0' }); }, [data]); // eslint-disable-line
  if (loading && !data) return <Loading />;
  const save = async () => {
    if (await run(() => api.saveSettings({ tax_percent: String(v.tax_percent), grace_days: String(v.grace_days), invoice_due_days: String(v.invoice_due_days), invoice_prefix: String(v.invoice_prefix), signup_open: v.signup_open ? '1' : '0' }), 'Settings saved') !== undefined) reload();
  };
  const runJob = async (name: string, label: string) => {
    if (!(await dialog.confirm({ title: 'Run job now', message: `${label}. Jobs are lock-protected and safe to run manually.`, confirmText: 'Run job' }))) return;
    const r = await run(() => api.runJob(name)); if (r) setResult({ job: name, ...r });
  };
  return (
    <>
      <PageHeader title="Settings" sub="Platform-wide billing rules and background jobs." />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!admin && <Alert>Only super admins can change settings. You can view the current values.</Alert>}
      <div className="grid g2">
        <Card title="Billing & signup">
          <div className="grid g2">
            <Field label="Tax rate (%)"><input className="input" inputMode="decimal" value={v.tax_percent} onChange={set('tax_percent')} disabled={!admin} /></Field>
            <Field label="Invoice due after (days)"><input className="input" inputMode="numeric" value={v.invoice_due_days} onChange={set('invoice_due_days')} disabled={!admin} /></Field>
            <Field label="Grace period before suspension (days)"><input className="input" inputMode="numeric" value={v.grace_days} onChange={set('grace_days')} disabled={!admin} /></Field>
            <Field label="Invoice number prefix"><input className="input" value={v.invoice_prefix} onChange={set('invoice_prefix')} disabled={!admin} /></Field>
          </div>
          <label className="check" style={{ margin: '4px 0 14px' }}><input type="checkbox" checked={v.signup_open} onChange={set('signup_open')} disabled={!admin} />Allow new customers to sign up</label>
          {admin && <button className="btn primary" onClick={save} disabled={busy}>Save settings</button>}
        </Card>
        <Card title="Background jobs">
          {JOBS.map(([name, label]) => (
            <div key={name} className="row" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div><b className="mono">{name}</b><div className="muted">{label}</div></div>
              {admin && <button className="btn sm" disabled={busy} onClick={() => runJob(name, label)}>Run now</button>}
            </div>
          ))}
          {busy && <div style={{ marginTop: 12 }}><Progress value={50} max={100} /></div>}
        </Card>
      </div>
      {result !== null && <Modal title="Job result" onClose={() => setResult(null)}><JsonView value={result} /></Modal>}
    </>
  );
}
