import { createContext, use, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';
import { FLAG_INFO } from '../lib/format.js';

/* ------------------------------------------------------------------ toasts */
const ToastContext = createContext(() => {});
export const useToast = () => use(ToastContext);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((message, type = 'info', ms = 3600) => {
    const id = Math.random().toString(36).slice(2);
    setItems((l) => [...l, { id, message, type }]);
    setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), ms);
  }, []);
  const tone = { info: 'border-brand', success: 'border-ok', error: 'border-uured', warn: 'border-warn' };
  const icon = { info: 'info', success: 'checkCircle', error: 'alert', warn: 'alert' };
  return (
    <ToastContext value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`pointer-events-auto flex max-w-md items-start gap-2 rounded-xl border-l-4 bg-white px-4 py-3 text-sm shadow-pop animate-slide ${tone[t.type]}`}>
            <Icon name={icon[t.type]} className={`mt-0.5 size-4 shrink-0 ${t.type === 'success' ? 'text-ok' : t.type === 'error' ? 'text-uured' : 'text-brand'}`} />
            <div>{t.message}</div>
          </div>
        ))}
      </div>
    </ToastContext>
  );
}

/* ------------------------------------------------------------------ modal */
export function Modal({ title, onClose, children, footer, wide = false, closable = true }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && closable) onClose?.(); };
    document.addEventListener('keydown', onKey);
    const prev = document.activeElement;
    const first = ref.current?.querySelector('input, select, textarea, button[data-autofocus]');
    setTimeout(() => first?.focus(), 30);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose, closable]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy/45 p-0 animate-fade sm:items-center sm:p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget && closable) onClose?.(); }} role="dialog" aria-modal="true" aria-label={title}>
      <div ref={ref} className={`flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white shadow-pop animate-pop sm:rounded-2xl ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'}`}>
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <h2 className="text-lg font-bold text-navy">{title}</h2>
          {closable && <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close"><Icon name="x" /></button>}
        </header>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

/** Promise-based confirm: const ok = await confirm({ title, message, danger }). Render <ConfirmHost/> once. */
let openConfirm = null;
export function ConfirmHost() {
  const [req, setReq] = useState(null);
  openConfirm = (r) => setReq(r);
  if (!req) return null;
  const done = (v) => { req.resolve(v); setReq(null); };
  return (
    <Modal title={req.title || 'Are you sure?'} onClose={() => done(false)}
      footer={<><button className="btn" onClick={() => done(false)}>Cancel</button>
        <button data-autofocus className={`btn ${req.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => done(true)}>{req.okText || 'Confirm'}</button></>}>
      <p className="text-sm">{req.message}</p>
    </Modal>
  );
}
export const confirm = (opts) => new Promise((resolve) => openConfirm?.({ ...opts, resolve }));

/* ------------------------------------------------------------------ form bits */
export function Field({ label, help, error, children, className = '' }) {
  return (
    <div className={className}>
      {label && <label className="label">{label}</label>}
      {children}
      {help && <p className="mt-1 text-xs text-muted">{help}</p>}
      {error && <p className="mt-1 text-xs font-semibold text-uured">{error}</p>}
    </div>
  );
}

export function PasswordInput({ name, autoComplete = 'new-password', required, minLength, placeholder, defaultValue, id }) {
  const [show, setShow] = useState(false);
  const autoId = useId();
  return (
    <div className="relative">
      <input className="input pr-11" id={id || autoId} name={name} type={show ? 'text' : 'password'} autoComplete={autoComplete}
        spellCheck="false" autoCapitalize="off" required={required} minLength={minLength} placeholder={placeholder} defaultValue={defaultValue} />
      <button type="button" className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-muted hover:text-brand"
        onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'} title={show ? 'Hide password' : 'Show password'}>
        <Icon name={show ? 'eyeOff' : 'eye'} className="size-5" />
      </button>
    </div>
  );
}

export function ErrorText({ children }) {
  if (!children) return null;
  return <div className="rounded-lg bg-uured-soft px-3 py-2.5 text-sm font-medium text-uured" role="alert">{children}</div>;
}

export function Spinner({ className = 'size-5' }) {
  return <span className={`inline-block animate-spin rounded-full border-2 border-current border-r-transparent ${className}`} aria-label="Loading" />;
}

export function SubmitButton({ pending, children, className = 'btn btn-primary' }) {
  return <button type="submit" className={className} disabled={pending} aria-busy={pending}>{pending && <Spinner className="size-4" />}{children}</button>;
}

/* ------------------------------------------------------------------ display */
export function Empty({ icon = 'info', children }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted">
      <Icon name={icon} className="size-9 text-line" strokeWidth={1.5} />
      <div>{children}</div>
    </div>
  );
}

export function Loading({ label = 'Loading…' }) {
  return <div className="flex items-center justify-center gap-3 py-16 text-sm text-muted"><Spinner />{label}</div>;
}

export function Stat({ label, value, sub, tone = 'brand', icon }) {
  const color = { brand: 'text-brand', ok: 'text-ok', red: 'text-uured', warn: 'text-warn', navy: 'text-navy' }[tone];
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-muted">
        <span>{label}</span>{icon && <Icon name={icon} className={`size-4 ${color}`} />}
      </div>
      <div className={`mt-2 text-3xl font-extrabold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function LiveBadge({ ok }) {
  return (
    <span className={`pill ${ok ? 'pill-ok' : 'pill-muted'}`}>
      <span className={`size-2 rounded-full ${ok ? 'bg-ok animate-pulse' : 'bg-uured'}`} />{ok ? 'Live' : 'Connecting'}
    </span>
  );
}

export function FlagPills({ flags }) {
  if (!flags) return null;
  return String(flags).split(',').filter(Boolean).map((f) => {
    const [cls, label, title] = FLAG_INFO[f] || ['', f, ''];
    return <span key={f} className={`pill ${cls}`} title={title}>{label}</span>;
  });
}

/** Photo with an initials fallback (photos are links; a broken one quietly turns into initials). */
export function Avatar({ src, name, className = 'size-10 text-sm' }) {
  const [broken, setBroken] = useState(false);
  const letters = String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  if (src && !broken) {
    return <img src={src} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setBroken(true)} className={`shrink-0 rounded-full bg-brand-soft object-cover ${className}`} />;
  }
  return <span className={`inline-flex shrink-0 items-center justify-center rounded-full bg-brand-soft font-bold text-brand ${className}`}>{letters}</span>;
}

export function copyText(text, toast) {
  navigator.clipboard?.writeText(text).then(() => toast?.('Copied to clipboard', 'success', 1500), () => {});
}

/** Download a server CSV through fetch (keeps the CSRF/session rules) and save it. */
export async function downloadFile(url, fallbackName) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || fallbackName;
  saveBlob(await res.blob(), name);
}
export function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
