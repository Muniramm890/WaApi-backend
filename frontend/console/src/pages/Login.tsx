import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { ApiError } from '../api/client';
import { Field, Spinner } from '../components/ui';

export default function Login() {
  const { user, login } = useAuth(); const loc = useLocation();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false); const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  if (user) return <Navigate to={(loc.state as any)?.from || '/'} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await login(email.trim(), password, needTotp ? totp.trim() : undefined, remember); }
    catch (err) {
      const e2 = err as ApiError;
      if (e2.code === 'TOTP_REQUIRED') { setNeedTotp(true); setError(''); } else setError(e2.message);
    } finally { setBusy(false); }
  };
  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="card-b">
          <div className="brand" style={{ padding: '0 0 14px' }}><img src="/favicon.svg" alt="" /><div>WA Platform<small>Control Center sign in</small></div></div>
          {error && <div className="alert bad">{error}</div>}
          {needTotp && <div className="alert">Enter the 6-digit code from your authenticator app.</div>}
          <Field label="Email"><input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus disabled={needTotp} /></Field>
          <Field label="Password"><input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required disabled={needTotp} /></Field>
          {needTotp && <Field label="Authentication code"><input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value)} required autoFocus /></Field>}
          <label className="check" style={{ marginBottom: 14 }}><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />Keep me signed in on this device</label>
          <button className="btn primary" style={{ width: '100%' }} disabled={busy}>{busy ? <Spinner /> : needTotp ? 'Verify and sign in' : 'Sign in'}</button>
        </div>
      </form>
    </div>
  );
}
