import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Modal } from '../components/ui/Modal';

interface Base { title: string; message?: ReactNode; confirmText?: string; cancelText?: string; danger?: boolean }
interface PromptOpts extends Base { label?: string; placeholder?: string; multiline?: boolean; required?: boolean; initial?: string }
type Req =
  | ({ kind: 'confirm'; resolve: (v: boolean) => void } & Base)
  | ({ kind: 'alert'; resolve: () => void } & Base)
  | ({ kind: 'prompt'; resolve: (v: string | null) => void } & PromptOpts);

interface Api { confirm: (o: Base) => Promise<boolean>; alert: (o: Base) => Promise<void>; prompt: (o: PromptOpts) => Promise<string | null> }
const Ctx = createContext<Api>(null as unknown as Api);

// Replaces native alert/confirm/prompt everywhere in the app.
export function DialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Req[]>([]);
  const [text, setText] = useState('');
  const cur = queue[0];
  const push = useCallback((r: Req) => { setText((r as PromptOpts).initial || ''); setQueue((q) => [...q, r]); }, []);
  const api = useMemo<Api>(() => ({
    confirm: (o) => new Promise((resolve) => push({ kind: 'confirm', resolve, ...o })),
    alert: (o) => new Promise((resolve) => push({ kind: 'alert', resolve: () => resolve(), ...o })),
    prompt: (o) => new Promise((resolve) => push({ kind: 'prompt', resolve, ...o })),
  }), [push]);
  const close = (fn: () => void) => { fn(); setQueue((q) => q.slice(1)); setText(''); };

  return (
    <Ctx.Provider value={api}>
      {children}
      {cur && (
        <Modal
          title={cur.title}
          onClose={() => close(() => (cur.kind === 'confirm' ? cur.resolve(false) : cur.kind === 'prompt' ? cur.resolve(null) : cur.resolve()))}
          footer={cur.kind === 'alert' ? (
            <button className="btn primary" onClick={() => close(() => (cur as any).resolve())} autoFocus>{cur.confirmText || 'OK'}</button>
          ) : (
            <>
              <button className="btn" onClick={() => close(() => (cur.kind === 'confirm' ? cur.resolve(false) : (cur as any).resolve(null)))}>{cur.cancelText || 'Cancel'}</button>
              <button
                className={'btn ' + (cur.danger ? 'danger' : 'primary')}
                disabled={cur.kind === 'prompt' && !!cur.required && !text.trim()}
                onClick={() => close(() => (cur.kind === 'confirm' ? cur.resolve(true) : (cur as any).resolve(text.trim())))}
              >{cur.confirmText || (cur.kind === 'confirm' ? 'Confirm' : 'Submit')}</button>
            </>
          )}
        >
          {cur.message && <div style={{ marginBottom: cur.kind === 'prompt' ? 12 : 0 }}>{cur.message}</div>}
          {cur.kind === 'prompt' && (
            <label className="field" style={{ marginBottom: 0 }}>
              {cur.label && <span className="label">{cur.label}</span>}
              {cur.multiline
                ? <textarea className="textarea" autoFocus value={text} placeholder={cur.placeholder} onChange={(e) => setText(e.target.value)} />
                : <input className="input" autoFocus value={text} placeholder={cur.placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (!cur.required || text.trim())) close(() => (cur as any).resolve(text.trim())); }} />}
            </label>
          )}
        </Modal>
      )}
    </Ctx.Provider>
  );
}
export const useDialog = () => useContext(Ctx);
