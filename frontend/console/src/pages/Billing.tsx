import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/endpoints';
import type { Invoice } from '../api/types';
import { useDialog } from '../contexts/DialogContext';
import { useAsync, useCursorList, useForm, useRun, useTenantNames } from '../lib/hooks';
import { day, dt, money, paiseToRupees, prevPeriod, rupeesToPaise } from '../lib/format';
import { DataTable, ErrorBox, Field, KV, LoadMore, Loading, Modal, PageHeader, Select, StatusBadge, TableCard } from '../components/ui';

export default function Billing() {
  const names = useTenantNames(); const dialog = useDialog(); const { run, busy } = useRun();
  const [status, setStatus] = useState(''); const [tenant, setTenant] = useState(''); const [open, setOpen] = useState<number | null>(null);
  const list = useCursorList<Invoice>(async (before) => (await api.invoices({ status: status || undefined, tenant_id: tenant ? Number(tenant) : undefined, before })).data, [status, tenant]);
  const generate = async () => {
    const p = await dialog.prompt({ title: 'Generate invoices', message: 'Creates one invoice per customer for the month (plan fee + extra message fees + tax). Customers that already have an invoice for the month are skipped.', label: 'Billing month (YYYY-MM)', initial: prevPeriod(), required: true, confirmText: 'Generate' });
    if (!p) return;
    const r = await run(() => api.runInvoices(p)); if (r) { await dialog.alert({ title: 'Invoices generated', message: `${r.created} new invoice(s) created for ${r.period}.` }); list.reload(); }
  };
  const enforce = async () => {
    if (!(await dialog.confirm({ title: 'Enforce overdue invoices', message: 'Marks late invoices as overdue and suspends customers that are past the grace period. Continue?', confirmText: 'Run now' }))) return;
    const r = await run(() => api.enforceDues()); if (r) { await dialog.alert({ title: 'Done', message: `${r.suspended} customer(s) suspended.` }); list.reload(); }
  };
  return (
    <>
      <PageHeader title="Billing" sub="Invoices for your plan and platform fees. Record payments as they arrive.">
        <button className="btn" onClick={enforce} disabled={busy}>Enforce dues</button><button className="btn primary" onClick={generate} disabled={busy}>Generate invoices</button>
      </PageHeader>
      <div className="filters">
        <Field label="Status"><Select value={status} onChange={setStatus} placeholder="All" options={['issued', 'overdue', 'paid', 'void']} /></Field>
        <Field label="Customer"><Select value={tenant} onChange={setTenant} placeholder="All customers" options={Object.entries(names).map(([id, n]) => ({ value: id, label: n }))} /></Field>
      </div>
      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      <TableCard>
        {list.loading ? <Loading /> : (
          <DataTable<Invoice> rows={list.items} onRowClick={(i) => setOpen(i.id)} empty="No invoices yet." cols={[
            { header: 'Invoice', render: (i) => <b className="mono">{i.number}</b> },
            { header: 'Customer', render: (i) => <Link to={`/tenants/${i.tenant_id}`} onClick={(e) => e.stopPropagation()}>{names[i.tenant_id] || `#${i.tenant_id}`}</Link> },
            { header: 'Period', render: (i) => `${day(i.period_start)} – ${day(i.period_end)}` },
            { header: 'Total', className: 'right', render: (i) => money(i.total_paise) },
            { header: 'Paid', className: 'right', render: (i) => money(i.paid_paise) },
            { header: 'Due date', render: (i) => day(i.due_at) },
            { header: 'Status', render: (i) => <StatusBadge status={i.status} /> },
          ]} />
        )}
        <LoadMore more={list.more} loading={list.loadingMore} onClick={list.loadMore} />
      </TableCard>
      {open && <InvoiceModal id={open} onClose={() => setOpen(null)} onChanged={list.reload} />}
    </>
  );
}

function InvoiceModal({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const { data: inv, loading, error, reload } = useAsync(() => api.invoice(id), [id]);
  const names = useTenantNames(); const dialog = useDialog(); const { run, busy } = useRun();
  const balance = inv ? inv.total_paise - inv.paid_paise : 0;
  const { v, set, setV } = useForm({ amount: '', method: 'upi', reference: '', note: '' });
  const canPay = inv && ['issued', 'overdue'].includes(inv.status);
  const pay = async () => {
    const amt = rupeesToPaise(v.amount || paiseToRupees(balance));
    if (await run(() => api.addPayment(id, { amount_paise: amt, method: v.method, reference: v.reference.trim() || undefined, note: v.note.trim() || undefined }), 'Payment recorded') !== undefined) { setV({ amount: '', method: 'upi', reference: '', note: '' }); reload(); onChanged(); }
  };
  const voidIt = async () => {
    const reason = await dialog.prompt({ title: 'Void invoice', message: 'A voided invoice no longer counts as outstanding. Only invoices without payments can be voided.', label: 'Reason', required: true, danger: true, confirmText: 'Void invoice' });
    if (reason && (await run(() => api.voidInvoice(id, reason), 'Invoice voided')) !== undefined) { reload(); onChanged(); }
  };
  return (
    <Modal wide title={inv ? `Invoice ${inv.number}` : 'Invoice'} onClose={onClose} busy={busy}
      footer={inv && canPay && inv.paid_paise === 0 ? <button className="btn danger" onClick={voidIt} disabled={busy}>Void invoice</button> : undefined}>
      {loading && !inv ? <Loading /> : error ? <ErrorBox error={error} onRetry={reload} /> : inv && (
        <>
          <KV rows={[['Customer', <Link to={`/tenants/${inv.tenant_id}`}>{names[inv.tenant_id] || `#${inv.tenant_id}`}</Link>], ['Status', <StatusBadge status={inv.status} />], ['Period', `${day(inv.period_start)} – ${day(inv.period_end)}`], ['Issued', dt(inv.issued_at)], ['Due', dt(inv.due_at)], ['Paid at', inv.paid_at ? dt(inv.paid_at) : '—'], ...(inv.void_reason ? [['Void reason', inv.void_reason] as [string, string]] : [])]} />
          <div className="table-wrap" style={{ margin: '14px 0' }}>
            <table className="t" style={{ minWidth: 0 }}><thead><tr><th>Description</th><th className="right">Qty</th><th className="right">Amount</th></tr></thead><tbody>
              {inv.lines.map((l, i) => <tr key={i}><td>{l.description}</td><td className="right">{l.quantity}</td><td className="right">{money(l.amount_paise)}</td></tr>)}
              <tr><td colSpan={2} className="right muted">Subtotal</td><td className="right">{money(inv.subtotal_paise)}</td></tr>
              <tr><td colSpan={2} className="right muted">Tax</td><td className="right">{money(inv.tax_paise)}</td></tr>
              <tr><td colSpan={2} className="right"><b>Total</b></td><td className="right"><b>{money(inv.total_paise)}</b></td></tr>
              <tr><td colSpan={2} className="right muted">Paid</td><td className="right">{money(inv.paid_paise)}</td></tr>
              <tr><td colSpan={2} className="right"><b>Balance</b></td><td className="right"><b>{money(balance)}</b></td></tr>
            </tbody></table>
          </div>
          {(inv.payments || []).length > 0 && <><h3 style={{ margin: '6px 0 8px' }}>Payments</h3><div className="table-wrap"><DataTable rows={inv.payments!} cols={[{ header: 'Date', render: (p) => dt(p.created_at) }, { header: 'Amount', className: 'right', render: (p) => money(p.amount_paise) }, { header: 'Method', render: (p) => p.method || '—' }, { header: 'Reference', render: (p) => p.reference || '—' }, { header: 'Note', render: (p) => p.note || '—' }]} /></div></>}
          {canPay && (
            <div className="card flat" style={{ marginTop: 14, marginBottom: 0 }}><div className="card-h">Record payment</div><div className="card-b">
              <div className="grid g2">
                <Field label="Amount (₹)" hint={`Leave empty to pay the full balance (${money(balance)})`}><input className="input" inputMode="decimal" value={v.amount} onChange={set('amount')} placeholder={paiseToRupees(balance)} /></Field>
                <Field label="Method"><Select value={v.method} onChange={set('method')} options={['upi', 'bank_transfer', 'card', 'cash', 'cheque', 'other']} /></Field>
                <Field label="Reference / UTR"><input className="input" value={v.reference} onChange={set('reference')} /></Field>
                <Field label="Note"><input className="input" value={v.note} onChange={set('note')} /></Field>
              </div>
              <button className="btn primary" onClick={pay} disabled={busy}>Record payment</button>
            </div></div>
          )}
        </>
      )}
    </Modal>
  );
}
