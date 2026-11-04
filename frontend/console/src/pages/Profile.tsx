import { useState } from 'react';
import { api } from '../api/endpoints';
import { useAuth } from '../contexts/AuthContext';
import { useDialog } from '../contexts/DialogContext';
import { useForm, useRun } from '../lib/hooks';
import { dt, title } from '../lib/format';
import { Alert, Badge, Card, CopyButton, Field, KV, PageHeader } from '../components/ui';

export default function Profile() {
  const { user, setUser, logout } = useAuth(); const dialog = useDialog(); const { run, busy } = useRun();
  const { v, setV, set } = useForm({ current: '', next: '', confirm: '' });
  const [setup, setSetup] = useState<{ secret: string; otpauth_uri: string } | null>(null); const [code, setCode] = useState('');
  if (!user) return null;
  const pwOk = v.next.length >= 10 && /[A-Za-z]/.test(v.next) && /\d/.test(v.next) && v.next === v.confirm && v.current.length > 0;
  const changePw = async () => {
    if (await run(() => api.changePassword(v.current, v.next), 'Password changed. Please sign in again.') !== undefined) { setV({ current: '', next: '', confirm: '' }); await logout(); }
  };
  const start = async () => { const r = await run(() => api.totpSetup()); if (r) setSetup(r); };
  const enable = async () => { if (await run(() => api.totpEnable(code.trim()), 'Two-factor authentication enabled') !== undefined) { setUser({ ...user, totp_enabled: true }); setSetup(null); setCode(''); } };
  const disable = async () => {
    const pw = await dialog.prompt({ title: 'Disable two-factor authentication', message: 'Your account will be protected by password only.', label: 'Confirm your password', danger: true, required: true, confirmText: 'Disable 2FA' });
    if (pw && (await run(() => api.totpDisable(pw), 'Two-factor authentication disabled')) !== undefined) setUser({ ...user, totp_enabled: false });
  };
  return (
    <>
      <PageHeader title="My account" />
      <div className="grid g2">
        <Card title="Profile"><KV rows={[['Name', user.name], ['Email', user.email], ['Role', title(user.role)], ['Last sign-in', dt(user.last_login_at)]]} /></Card>
        <Card title="Two-factor authentication" actions={user.totp_enabled ? <Badge kind="ok">On</Badge> : <Badge kind="warn">Off</Badge>}>
          {user.totp_enabled ? (<><p className="muted" style={{ marginTop: 0 }}>A code from your authenticator app is required at sign-in.</p><button className="btn danger" onClick={disable} disabled={busy}>Disable 2FA</button></>) : setup ? (
            <>
              <Alert>On your phone, tap the button below to open your authenticator app, or enter the key manually.</Alert>
              <p><a className="btn primary" href={setup.otpauth_uri}>Open authenticator app</a></p>
              <Field label="Secret key"><div className="row"><input className="input mono" readOnly value={setup.secret} /><CopyButton text={setup.secret} /></div></Field>
              <Field label="Enter the 6-digit code to confirm"><input className="input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
              <button className="btn primary" onClick={enable} disabled={busy || code.trim().length !== 6}>Enable 2FA</button>
            </>
          ) : (<><p className="muted" style={{ marginTop: 0 }}>Add a second step to protect this powerful account.</p><button className="btn primary" onClick={start} disabled={busy}>Set up 2FA</button></>)}
        </Card>
      </div>
      <Card title="Change password">
        <div className="grid g3">
          <Field label="Current password"><input className="input" type="password" autoComplete="current-password" value={v.current} onChange={set('current')} /></Field>
          <Field label="New password" hint="At least 10 characters, letters and numbers."><input className="input" type="password" autoComplete="new-password" value={v.next} onChange={set('next')} /></Field>
          <Field label="Confirm new password"><input className="input" type="password" autoComplete="new-password" value={v.confirm} onChange={set('confirm')} /></Field>
        </div>
        <button className="btn primary" onClick={changePw} disabled={!pwOk || busy}>Change password</button>
      </Card>
    </>
  );
}
