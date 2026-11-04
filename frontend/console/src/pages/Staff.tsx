import { useState } from 'react';
import { api } from '../api/endpoints';
import type { Staff as S } from '../api/types';
import { useAuth } from '../contexts/AuthContext';
import { useAsync, useForm, useRun } from '../lib/hooks';
import { ago, title } from '../lib/format';
import { Badge, DataTable, ErrorBox, Field, Icon, Loading, Modal, PageHeader, Select, StatusBadge, TableCard } from '../components/ui';

const ROLES = [{ value: 'super_admin', label: 'Super admin — everything' }, { value: 'support', label: 'Support — customers, WhatsApp, plans' }, { value: 'finance', label: 'Finance — invoices & payments' }];

export default function Staff() {
  const { user } = useAuth(); const { data, loading, error, reload } = useAsync(() => api.staff(), []);
  const [edit, setEdit] = useState<S | 'new' | null>(null); const [pw, setPw] = useState<S | null>(null);
  return (
    <>
      <PageHeader title="Staff" sub="People who can sign in to this Control Center."><button className="btn primary" onClick={() => setEdit('new')}><Icon name="plus" />Add staff</button></PageHeader>
      {error && <ErrorBox error={error} onRetry={reload} />}
      <TableCard>{loading ? <Loading /> : (
        <DataTable<S> rows={data?.data || []} onRowClick={setEdit} cols={[
          { header: 'Name', render: (s) => <span><b>{s.name}</b>{s.id === user?.id && <> <Badge kind="info">you</Badge></>}</span> },
          { header: 'Email', render: (s) => s.email }, { header: 'Role', render: (s) => title(s.role) },
          { header: 'Status', render: (s) => <StatusBadge status={s.status} /> }, { header: '2FA', render: (s) => (s.totp_enabled ? <Badge kind="ok">On</Badge> : <Badge>Off</Badge>) },
          { header: 'Last login', render: (s) => ago(s.last_login_at) },
          { header: '', render: (s) => <button className="btn sm" onClick={(e) => { e.stopPropagation(); setPw(s); }}>Reset password</button> },
        ]} />
      )}</TableCard>
      {edit && <StaffForm staff={edit === 'new' ? null : edit} self={edit !== 'new' && edit.id === user?.id} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
      {pw && <ResetPw staff={pw} onClose={() => setPw(null)} />}
    </>
  );
}

function StaffForm({ staff, self, onClose, onDone }: { staff: S | null; self: boolean; onClose: () => void; onDone: () => void }) {
  const { v, set } = useForm({ email: staff?.email || '', name: staff?.name || '', role: staff?.role || 'support', status: staff?.status || 'active', password: '' }); const { run, busy } = useRun();
  const save = async () => {
    const r = staff ? await run(() => api.updateStaff(staff.id, { name: v.name.trim(), role: v.role, status: v.status }), 'Staff updated') : await run(() => api.createStaff({ email: v.email.trim(), name: v.name.trim(), role: v.role, password: v.password }), 'Staff member added');
    if (r !== undefined) onDone();
  };
  const valid = v.name.trim().length > 1 && (staff || (/\S+@\S+\.\S+/.test(v.email) && v.password.length >= 10 && /[A-Za-z]/.test(v.password) && /\d/.test(v.password)));
  return (
    <Modal title={staff ? `Edit ${staff.name}` : 'Add staff member'} onClose={onClose} busy={busy} footer={<><button className="btn" onClick={onClose} disabled={busy}>Cancel</button><button className="btn primary" onClick={save} disabled={!valid || busy}>Save</button></>}>
      <Field label="Name"><input className="input" value={v.name} onChange={set('name')} autoFocus /></Field>
      {!staff && <Field label="Email"><input className="input" type="email" value={v.email} onChange={set('email')} /></Field>}
      <Field label="Role" hint={self ? 'You cannot change your own role or disable yourself.' : undefined}><Select value={v.role} onChange={set('role')} options={ROLES} /></Field>
      {staff && !self && <Field label="Status"><Select value={v.status} onChange={set('status')} options={['active', 'disabled']} /></Field>}
      {!staff && <Field label="Temporary password" hint="At least 10 characters with letters and numbers. Share it securely; they can change it after signing in."><input className="input" type="text" autoComplete="new-password" value={v.password} onChange={set('password')} /></Field>}
    </Modal>
  );
}

function ResetPw({ staff, onClose }: { staff: S; onClose: () => void }) {
  const [pw, setPw] = useState(''); const { run, busy } = useRun(); const ok = pw.length >= 10 && /[A-Za-z]/.test(pw) && /\d/.test(pw);
  return (
    <Modal title={`Reset password for ${staff.name}`} onClose={onClose} busy={busy} footer={<><button className="btn" onClick={onClose} disabled={busy}>Cancel</button><button className="btn primary" disabled={!ok || busy} onClick={async () => { if (await run(() => api.resetStaffPassword(staff.id, pw), 'Password reset. All their sessions were signed out.') !== undefined) onClose(); }}>Reset password</button></>}>
      <Field label="New password" hint="At least 10 characters with letters and numbers."><input className="input" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></Field>
    </Modal>
  );
}
