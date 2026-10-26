import { useActionState, useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { directionLabel } from '../lib/format.js';
import { BrandHeader, Footer } from '../components/Brand.jsx';
import { StudentCard } from '../components/StudentCard.jsx';
import { ErrorText, Loading, SubmitButton } from '../components/ui.jsx';
import { Icon } from '../components/Icon.jsx';

/*
 * Student verification, opened by scanning the bus QR (/checkin/<bus>?t=<token>). No login:
 *  1. the QR token is exchanged for a short private session tied to this phone
 *  2. the student types their UUID or enrollment number and taps Verify
 *  3. the card shows BUS NO., photo, name, course, route, enrollment number and VERIFIED
 */
const DEVICE_KEY = 'uu_device';
const LAST_KEY = 'uu_last_id';

// Phone identity: HttpOnly cookie mirrored in localStorage, so clearing one alone is not a new phone.
try { const d = localStorage.getItem(DEVICE_KEY); if (d) api.extraHeaders['X-Device-Token'] = d; } catch { /* storage blocked */ }
const rememberDevice = (tok) => {
  if (!tok) return;
  api.extraHeaders['X-Device-Token'] = tok;
  try { localStorage.setItem(DEVICE_KEY, tok); } catch { /* storage blocked */ }
};
const lastId = () => { try { return localStorage.getItem(LAST_KEY) || ''; } catch { return ''; } };

export default function Checkin() {
  const [phase, setPhase] = useState({ name: 'loading' });
  const onExpired = useCallback(() => setPhase({ name: 'scan', reason: 'EXPIRED' }), []);
  const onDone = useCallback((r) => setPhase({ name: 'done', ...r }), []);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const token = params.get('t');
    const bus = decodeURIComponent(location.pathname.split('/')[2] || '');
    (async () => {
      try {
        if (token) {
          const s = await api.post('/api/checkin/session', { token, bus: bus || undefined });
          rememberDevice(s.device);
          // drop the token from the address bar: a reload uses the session, a shared link is useless
          history.replaceState(null, '', location.pathname);
          setPhase({ name: 'form', trip: s.trip, expiresAt: s.expiresAt });
          return;
        }
        const s = await api.get('/api/checkin/session');
        rememberDevice(s.device);
        if (!s.active) return setPhase({ name: 'scan', reason: s.reason });
        if (s.student && s.consumed) return setPhase({ name: 'done', trip: s.trip, student: s.student, boardedAt: s.boardedAt, already: false });
        setPhase({ name: 'form', trip: s.trip, expiresAt: s.expiresAt });
      } catch (e) {
        setPhase({ name: 'error', code: e.code, message: e.message });
      }
    })();
  }, []);

  return (
    <div className="min-h-dvh">
      <BrandHeader />
      <main className="mx-auto my-6 w-[min(560px,94%)]">
        {phase.name === 'loading' && <Loading label="Opening verification…" />}
        {phase.name === 'form' && <VerifyForm trip={phase.trip} expiresAt={phase.expiresAt} onDone={onDone} onExpired={onExpired} />}
        {phase.name === 'done' && <Done {...phase} />}
        {phase.name === 'scan' && (
          <Notice icon="scan" title={phase.reason === 'TRIP_ENDED' ? 'This trip has ended' : 'Scan the bus QR code'}>
            {phase.reason === 'TRIP_ENDED'
              ? 'The incharge has ended this trip. Scan the QR code on your bus for the next trip.'
              : 'Open your phone camera and scan the QR code shown inside your bus. The verification page opens by itself.'}
          </Notice>
        )}
        {phase.name === 'error' && (
          <Notice icon={phase.code === 'NO_TRIP' ? 'clock' : 'alert'} tone={phase.code === 'NO_TRIP' ? 'warn' : 'red'}
            title={phase.code === 'NO_TRIP' ? 'No trip running yet' : phase.code === 'QR_EXPIRED' ? 'QR code expired' : 'Could not open verification'}>
            {phase.message}
          </Notice>
        )}
      </main>
      <Footer />
    </div>
  );
}

function TripBanner({ trip }) {
  return (
    <div className="mb-4 flex items-center gap-4 rounded-xl border border-line bg-brand-soft p-3.5">
      <img src="/img/campus-buses.jpg" alt="" width="110" height="72" className="h-[60px] w-20 shrink-0 rounded-md object-cover sm:h-[72px] sm:w-[110px]" />
      <div className="min-w-0">
        <strong className="text-navy">Bus {trip.bus_number}{trip.bus_name && trip.bus_name !== `Bus ${trip.bus_number}` ? ` · ${trip.bus_name}` : ''}</strong>
        <p className="text-sm text-muted">{directionLabel(trip.direction)} · Student identity verification</p>
      </div>
    </div>
  );
}

function VerifyForm({ trip, expiresAt, onDone, onExpired }) {
  const [left, setLeft] = useState(() => Math.max(0, Math.round((expiresAt - Date.now()) / 1000)));
  useEffect(() => {
    const t = setInterval(() => {
      const s = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      setLeft(s);
      if (!s) { clearInterval(t); onExpired(); }
    }, 1000);
    return () => clearInterval(t);
  }, [expiresAt, onExpired]);

  const [state, action, pending] = useActionState(async (_prev, form) => {
    const id = String(form.get('id') || '').trim();
    if (!id) return { error: 'Enter your UUID or enrollment number.', id };
    try {
      const r = await api.post('/api/checkin/verify', { id });
      try { localStorage.setItem(LAST_KEY, id); } catch { /* storage blocked */ }
      onDone({ trip: r.trip, student: r.student, boardedAt: r.boardedAt, already: r.already });
      return { error: null, id };
    } catch (e) {
      if (e.code === 'SESSION_EXPIRED' || e.code === 'TRIP_ENDED') onExpired();
      return { error: e.message, id };
    }
  }, { error: null, id: lastId() });

  return (
    <section className="card p-[22px]">
      <h2 className="text-xl font-bold text-navy">Student Verification</h2>
      <div className="mt-3"><TripBanner trip={trip} /></div>
      <p className="text-muted">Enter your UUID or enrollment number.</p>
      <form action={action} className="mt-4 flex flex-col gap-4" autoComplete="off">
        <div>
          <label className="label" htmlFor="sid">UUID / Enrollment Number</label>
          <input id="sid" name="id" className="input py-3 font-mono text-lg uppercase tracking-wide" defaultValue={state.id}
            autoCapitalize="characters" autoCorrect="off" spellCheck="false" inputMode="text" enterKeyHint="go" maxLength={40} required autoFocus />
        </div>
        <ErrorText>{state.error}</ErrorText>
        <SubmitButton pending={pending} className="btn btn-primary w-full py-3.5 text-base">{pending ? 'Verifying student…' : 'Verify Student'}</SubmitButton>
      </form>
      <p className="mt-4 flex items-center gap-1.5 text-xs text-muted">
        <Icon name="clock" className="size-3.5" />
        {left > 0 ? `This page stays open for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}. Use your own phone.` : 'Expired. Scan the QR again.'}
      </p>
    </section>
  );
}

function Done({ trip, student, boardedAt, already }) {
  return (
    <div className="flex flex-col gap-4">
      <div className={`rounded-lg px-3 py-3 text-sm font-semibold ${already ? 'bg-warn-soft text-warn' : 'bg-ok-soft text-ok'}`} role="status">
        {already ? 'Already verified on this trip. Show this screen to the incharge if asked.' : 'Student verified successfully.'}
      </div>
      <StudentCard student={student} busNumber={trip?.bus_number} verifiedAt={boardedAt} already={already} direction={trip?.direction} />
    </div>
  );
}

function Notice({ icon, title, children, tone = 'brand' }) {
  const color = { brand: 'text-brand bg-brand-soft', warn: 'text-warn bg-warn-soft', red: 'text-uured bg-uured-soft' }[tone];
  return (
    <section className="card p-8 text-center">
      <div className={`mx-auto mb-4 flex size-14 items-center justify-center rounded-full ${color}`}><Icon name={icon} className="size-7" /></div>
      <h2 className="text-xl font-bold text-navy">{title}</h2>
      <p className="mt-3 text-muted">{children}</p>
    </section>
  );
}
