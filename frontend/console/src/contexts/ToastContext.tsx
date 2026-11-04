import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

interface T { id: number; kind: 'ok' | 'bad' | 'info'; text: string }
interface Api { success: (m: string) => void; error: (m: string) => void; info: (m: string) => void }
const Ctx = createContext<Api>({ success() {}, error() {}, info() {} });
let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<T[]>([]);
  const push = useCallback((kind: T['kind'], text: string) => {
    const id = ++seq; setItems((p) => [...p, { id, kind, text }]);
    setTimeout(() => setItems((p) => p.filter((x) => x.id !== id)), kind === 'bad' ? 6000 : 3500);
  }, []);
  const api = useMemo<Api>(() => ({ success: (m) => push('ok', m), error: (m) => push('bad', m), info: (m) => push('info', m) }), [push]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">{items.map((t) => <div key={t.id} className={'toast ' + t.kind}>{t.text}</div>)}</div>
    </Ctx.Provider>
  );
}
export const useToast = () => useContext(Ctx);
