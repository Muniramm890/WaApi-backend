import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/endpoints';
import { refreshSession, setAccessToken, setAuthLostHandler, tokenStore } from '../api/client';
import type { Staff } from '../api/types';
import { useToast } from './ToastContext';

interface A {
  user: Staff | null; ready: boolean;
  login: (email: string, password: string, totp: string | undefined, remember: boolean) => Promise<void>;
  logout: () => Promise<void>; setUser: (u: Staff) => void;
}
const Ctx = createContext<A>(null as unknown as A);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Staff | null>(null);
  const [ready, setReady] = useState(false);
  const toast = useToast();

  useEffect(() => {
    setAuthLostHandler(() => { setUser(null); toast.info('Your session has expired. Please sign in again.'); });
    (async () => {
      if (tokenStore.get() && (await refreshSession()) === 'ok') {
        try { setUser((await api.me()).user); } catch { /* fall through to login */ }
      }
      setReady(true);
    })();
    return () => setAuthLostHandler(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login: A['login'] = async (email, password, totp, remember) => {
    const r = await api.login(email, password, totp);
    setAccessToken(r.access_token); tokenStore.set(r.refresh_token, remember); setUser(r.user);
  };
  const logout = useCallback(async () => {
    const rt = tokenStore.get();
    if (rt) { try { await api.logout(rt); } catch { /* ignore */ } }
    tokenStore.clear(); setAccessToken(null); setUser(null);
  }, []);

  return <Ctx.Provider value={{ user, ready, login, logout, setUser }}>{children}</Ctx.Provider>;
}
export const useAuth = () => useContext(Ctx);
