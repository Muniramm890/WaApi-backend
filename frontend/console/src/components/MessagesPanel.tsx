import { useState } from 'react';
import { api } from '../api/endpoints';
import type { Message } from '../api/types';
import { useCursorList, useTenantNames } from '../lib/hooks';
import { dt } from '../lib/format';
import { DataTable, ErrorBox, Field, JsonView, LoadMore, Loading, Modal, Select, StatusBadge, TableCard } from './ui';

export function MessagesPanel({ tenantId }: { tenantId?: number }) {
  const names = useTenantNames();
  const [tenant, setTenant] = useState(''); const [status, setStatus] = useState(''); const [direction, setDirection] = useState(''); const [errorCode, setErrorCode] = useState('');
  const [open, setOpen] = useState<Message | null>(null);
  const tid = tenantId ?? (tenant ? Number(tenant) : undefined);
  const list = useCursorList<Message>(async (before) => (await api.messages({ tenant_id: tid, status: status || undefined, direction: direction || undefined, error_code: errorCode || undefined, before })).data, [tid, status, direction, errorCode]);
  return (
    <>
      <div className="filters">
        {tenantId === undefined && <Field label="Customer"><Select value={tenant} onChange={setTenant} placeholder="All customers" options={Object.entries(names).map(([id, n]) => ({ value: id, label: n }))} /></Field>}
        <Field label="Status"><Select value={status} onChange={setStatus} placeholder="Any status" options={['queued', 'accepted', 'sent', 'delivered', 'read', 'failed', 'received']} /></Field>
        <Field label="Direction"><Select value={direction} onChange={setDirection} placeholder="Both" options={[{ value: 'out', label: 'Outbound' }, { value: 'in', label: 'Inbound' }]} /></Field>
        <Field label="Error code"><input className="input" value={errorCode} onChange={(e) => setErrorCode(e.target.value)} placeholder="e.g. 131026" /></Field>
        <button className="btn" onClick={list.reload}>Refresh</button>
      </div>
      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      <TableCard>
        {list.loading ? <Loading /> : (
          <DataTable<Message> rows={list.items} onRowClick={setOpen} empty="No messages match these filters."
            cols={[
              { header: 'Time', render: (m) => <span className="nowrap">{dt(m.created_at)}</span> },
              ...(tenantId === undefined ? [{ header: 'Customer', render: (m: Message) => names[m.tenant_id as number] || `#${m.tenant_id ?? '—'}` }] : []),
              { header: 'Dir', render: (m) => (m.direction === 'in' ? '↓ In' : '↑ Out') },
              { header: 'Number', render: (m) => <span className="mono">{m.wa_id}</span> },
              { header: 'Content', render: (m) => <span>{m.template ? `Template: ${m.template.name}` : m.preview || m.type}</span> },
              { header: 'Category', render: (m) => m.pricing_category || m.category || '—' },
              { header: 'Status', render: (m) => <StatusBadge status={m.status} /> },
              { header: 'Error', render: (m) => (m.error ? <span className="muted" title={m.error.message}>{m.error.code}</span> : '') },
            ]} />
        )}
        <LoadMore more={list.more} loading={list.loadingMore} onClick={list.loadMore} />
      </TableCard>
      {open && <Modal title={`Message #${open.id}`} wide onClose={() => setOpen(null)}><JsonView value={open} /></Modal>}
    </>
  );
}
