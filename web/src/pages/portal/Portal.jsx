import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';
import { api, qs } from '../../lib/api.js';
import { useLocation, Link, navigate } from '../../lib/router.jsx';
import { useSession } from '../../lib/session.jsx';
import { useFetch } from '../../lib/useFetch.js';
import { useLive, useThrottled } from '../../lib/live.js';
import { fmtTime, directionLabel } from '../../lib/format.js';
import { BrandHeader } from '../../components/Brand.jsx';
import { Icon } from '../../components/Icon.jsx';
import { PasswordChange } from '../../components/PasswordChange.jsx';
import { Avatar, Empty, ErrorText, FlagPills, LiveBadge, Loading, Modal, Spinner, confirm, useToast } from '../../components/ui.jsx';

/*
 * Bus portals.
 *  /bus/<number>  one bus: start the trip, show its QR, live count, roster, manual check-in, end trip.
 *                 Its incharge runs it; the super admin can too; operations admins only watch.
 *  /incharge      every bus portal with its live status (admins and incharges without a bus).
 */
export default function Portal() {
  const { user, logout, refresh } = useSession();
  const { path } = useLocation();
  const busNo = path.startsWith('/bus/') ? decodeURIComponent(path.slice(5).replace(/\/$/, '')) : null;
  const [pw, setPw] = useState(false);
  const [kiosk, setKiosk] = useState(false);
  const live = useRef({});
  const ok = useLive({ checkin: (d) => live.current.checkin?.(d), duplicate: (d) => live.current.duplicate?.(d), trip: (d) => live.current.trip?.(d) }, !user.mustChangePassword);
  const canSeeAll = user.role !== 'incharge' || user.bus_id == null;

  return (
    <div className="min-h-dvh">
      {!kiosk && (
        <BrandHeader compact subtitle={busNo ? `Bus ${busNo} portal` : 'Bus portals'} right={(
          <div className="flex shrink-0 items-center gap-2">
            <span className="hidden sm:inline"><LiveBadge ok={ok} /></span>
            {busNo && canSeeAll && <Link to="/incharge" className="btn btn-sm hidden border-white/30 bg-white/10 text-white hover:bg-white/20 sm:inline-flex">All buses</Link>}
            {user.role !== 'incharge' && <Link to="/admin" className="btn btn-sm border-white/30 bg-white/10 text-white hover:bg-white/20">Console</Link>}
            {user.canChangePassword && <button className="btn btn-sm btn-icon border-white/30 bg-white/10 text-white hover:bg-white/20" title="Change password" onClick={() => setPw(true)}><Icon name="key" className="size-4" /></button>}
            <button className="btn btn-sm border-white/30 bg-white/10 text-white hover:bg-white/20" onClick={logout} title={`Signed in as ${user.name}`}><Icon name="logout" className="size-4" /><span className="hidden sm:inline">Sign out</span></button>
          </div>
        )} />
      )}
      <main className={kiosk ? 'p-4' : 'mx-auto max-w-7xl p-4 page-enter sm:p-6'}>
        {user.mustChangePassword ? null : busNo
          ? <BusPortal key={busNo} busNo={busNo} live={live} kiosk={kiosk} setKiosk={setKiosk} />
          : <Picker live={live} />}
      </main>
      {(pw || user.mustChangePassword) && <PasswordChange forced={user.mustChangePassword} onClose={() => setPw(false)} onDone={() => { setPw(false); refresh(); }} />}
    </div>
  );
}

/* ------------------------------------------------------------------ all buses */
function Picker({ live }) {
  const { user } = useSession();
  const { data, loading, error, reload } = useFetch('/api/incharge/buses');
  const again = useThrottled(reload, 1500);
  live.current = { trip: again, checkin: again, duplicate: null };
  if (loading && !data) return <Loading />;
  if (error) return <div className="card"><Empty icon="alert">{error.message}</Empty></div>;
  const running = data.buses.filter((b) => b.trip).length;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-xl font-bold text-navy">Buses</h2><p className="text-sm text-muted">{user.readOnly ? 'Open any bus to watch its verification live.' : 'Each bus has its own portal, QR code and incharge.'}</p></div>
        <div className="flex gap-2"><span className="pill">{data.buses.length} buses</span><span className={`pill ${running ? 'pill-ok' : 'pill-muted'}`}>{running} running</span></div>
      </div>
      {data.buses.length ? (
        <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.buses.map((b) => (
            <Link key={b.id} to={`/bus/${encodeURIComponent(b.number)}`} className="card flex flex-col gap-3 p-4 transition hover:border-brand">
              <div className="flex items-center gap-3">
                <span className="flex h-11 min-w-11 items-center justify-center rounded-xl bg-brand px-2 text-sm font-extrabold text-white">{b.number}</span>
                <div className="min-w-0 grow"><div className="truncate font-bold text-navy">{b.name}</div><div className="truncate text-xs text-muted">{b.incharge_name || 'No incharge yet'}</div></div>
                {b.trip ? <span className="pill pill-ok">Running</span> : <span className="pill pill-muted">Idle</span>}
              </div>
              {b.trip
                ? <div className="text-sm"><b className="text-ok">{b.trip.boarded}</b> of {b.students} verified · {directionLabel(b.trip.direction)}</div>
                : <div className="text-sm text-muted">{b.students} students</div>}
            </Link>
          ))}
        </div>
      ) : <div className="card"><Empty icon="bus">No buses yet. The super admin can import them from the Excel workbook.</Empty></div>}
    </div>
  );
}

/* ------------------------------------------------------------------ one bus */
function BusPortal({ busNo, live, kiosk, setKiosk }) {
  const { user } = useSession();
  const [state, setState] = useState({ loading: true });
  const load = useCallback(async () => {
    try {
      const s = await api.get(`/api/incharge/state${qs({ bus: busNo })}`);
      const running = s.activeTrips.find((t) => t.bus_id === s.scopedBus.id);
      setState({ bus: s.scopedBus, tripId: running?.id ?? null, qrMode: s.qr.mode });
    } catch (e) {
      if (e.code === 'WRONG_BUS_PORTAL' && user.home) { navigate(user.home, { replace: true }); return; }
      setState({ error: e });
    }
  }, [busNo, user.home]);
  useEffect(() => { load(); }, [load]);

  if (state.loading) return <Loading />;
  if (state.error) return <div className="card"><Empty icon={state.error.status === 404 ? 'bus' : 'alert'}>{state.error.message}</Empty></div>;
  if (!state.tripId) {
    live.current = { trip: (d) => { if (d.trip.bus_id === state.bus.id && d.type === 'started') setState((s) => ({ ...s, tripId: d.trip.id })); } };
    return <StartTrip bus={state.bus} onStarted={(id) => setState((s) => ({ ...s, tripId: id }))} />;
  }
  return <TripLive key={state.tripId} tripId={state.tripId} bus={state.bus} live={live} kiosk={kiosk} setKiosk={setKiosk} onEnded={() => { setKiosk(false); load(); }} />;
}

function StartTrip({ bus, onStarted }) {
  const { user } = useSession();
  const toast = useToast();
  const hourIst = Number(new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(Date.now()));
  const [direction, setDirection] = useState(hourIst < 13 ? 'to_college' : 'from_college');
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try { const r = await api.post('/api/incharge/trips', { bus_id: bus.id, direction }); onStarted(r.trip.id); }
    catch (e) { toast(e.message, 'error'); setBusy(false); }
  };
  return (
    <div className="mx-auto grid max-w-4xl grid-cols-1 gap-4 md:grid-cols-[1.2fr_1fr]">
      <section className="card p-6">
        <div className="flex items-start justify-between gap-3">
          <div><h2 className="text-2xl font-bold text-navy">Bus {bus.number}</h2><p className="text-sm text-muted">{bus.name}{bus.route ? ` · ${bus.route}` : ''}</p></div>
          <span className="flex h-12 min-w-12 items-center justify-center rounded-xl bg-uured px-2 font-extrabold text-white">{bus.number}</span>
        </div>
        {user.readOnly ? (
          <Empty icon="clock">No trip is running on this bus. This page updates by itself when the incharge starts one.</Empty>
        ) : (
          <>
            <p className="mt-5 text-sm font-bold">Which trip is this?</p>
            <div className="mt-2 grid grid-cols-2 gap-3">
              {[['to_college', 'Morning', 'To college', 'school'], ['from_college', 'Evening', 'From college', 'home']].map(([k, title, sub, ic]) => (
                <button key={k} onClick={() => setDirection(k)} className={`flex flex-col items-center gap-1 rounded-2xl border-2 p-4 transition-all duration-200 active:scale-[0.98] ${direction === k ? 'border-brand bg-brand-soft text-brand shadow-[var(--shadow-lift)]' : 'border-line text-muted hover:-translate-y-0.5 hover:border-brand/50'}`}>
                  <Icon name={ic} className="size-7" /><span className="font-bold text-ink">{title}</span><span className="text-xs">{sub}</span>
                </button>
              ))}
            </div>
            <button className="btn btn-primary mt-5 w-full py-3.5 text-base" onClick={start} disabled={busy}>{busy ? <Spinner className="size-4" /> : <Icon name="play" className="size-4" />}Start trip and show QR</button>
          </>
        )}
      </section>
      <section className="card flex flex-col gap-3 p-6 text-sm">
        <h3 className="font-bold text-navy">On this bus</h3>
        <div className="flex items-center gap-2"><Icon name="users" className="size-4 text-brand" /><b>{bus.students}</b> registered students</div>
        <div className="flex items-center gap-2"><Icon name="user" className="size-4 text-brand" />{bus.incharges.join(', ') || 'No incharge assigned'}</div>
        {bus.stops.length > 0 && <div><div className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">Routes</div><div className="flex flex-wrap gap-1.5">{bus.stops.map((s) => <span key={s} className="pill pill-muted">{s}</span>)}</div></div>}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ running trip */
function TripLive({ tripId, bus, live, kiosk, setKiosk, onEnded }) {
  const { user } = useSession();
  const toast = useToast();
  const { data, error, setData, reload } = useFetch(`/api/incharge/trips/${tripId}`);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim().toLowerCase());
  const [last, setLast] = useState(null);
  const [manual, setManual] = useState(false);
  const [sound, setSound] = useState(true);
  const [bump, setBump] = useState(0);
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const resync = useThrottled(reload, 3000);

  live.current = {
    checkin: (d) => {
      if (d.trip.id !== tripId) return;
      const c = d.checkin;
      setData((s) => (!s || s.checkins.some((x) => x.id === c.id) ? s : {
        ...s, counts: d.counts,
        checkins: [{ ...c, student_bus_id: d.trip.bus_id }, ...s.checkins],
        notBoarded: s.notBoarded.filter((x) => x.id !== c.student_id),
      }));
      setLast({ ...c, at: Date.now() });
      setBump((n) => n + 1);
      if (soundRef.current) beep();
    },
    duplicate: (d) => {
      if (d.trip_id !== tripId) return;
      setData((s) => (s ? { ...s, counts: d.counts } : s));
      toast(`Already verified: ${d.name}`, 'warn', 2500);
    },
    trip: (d) => { if (d.trip.id === tripId && d.type === 'ended') onEnded(); else if (d.trip.id === tripId) resync(); },
  };

  // keep the screen on while the QR is shown (where the browser allows it)
  useEffect(() => {
    if (user.readOnly || !navigator.wakeLock) return undefined;
    let lock = null;
    const req = () => navigator.wakeLock.request('screen').then((l) => { lock = l; }, () => {});
    req();
    const onVis = () => { if (!document.hidden) req(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { document.removeEventListener('visibilitychange', onVis); lock?.release().catch(() => {}); };
  }, [user.readOnly]);

  const end = async () => {
    if (!(await confirm({ title: 'End this trip?', message: `${data.counts.boarded} of ${data.counts.expected} students verified. The QR stops working immediately.`, okText: 'End trip', danger: true }))) return;
    try { await api.post(`/api/incharge/trips/${tripId}/end`); toast('Trip ended', 'success'); onEnded(); } catch (e) { toast(e.message, 'error'); }
  };

  if (error) return <div className="card"><Empty icon="alert">{error.message}</Empty></div>;
  if (!data) return <Loading />;
  const { trip, counts } = data;
  const pct = counts.expected ? Math.min(100, Math.round((counts.boarded / counts.expected) * 100)) : 0;
  const done = data.checkins.map((c) => ({ ...c, id: c.student_id, at: c.created_at, checkinId: c.id }));
  const pending = data.notBoarded;
  let rows = filter === 'done' ? done : filter === 'pending' ? pending : [...done, ...pending];
  if (query) rows = rows.filter((r) => `${r.name} ${r.uuid} ${r.enrollment_no || ''} ${r.stop || ''}`.toLowerCase().includes(query));
  const fresh = last && Date.now() - last.at < 20000 ? last : null;

  return (
    <div className={`grid grid-cols-1 gap-4 ${kiosk ? 'lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]' : 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]'}`}>
      {user.readOnly ? (
        <section className="card flex flex-col gap-2 p-6">
          <h2 className="text-2xl font-bold text-navy">Bus {trip.bus_number}</h2>
          <p className="text-sm text-muted">{directionLabel(trip.direction)} · started {fmtTime(trip.started_at)} by {trip.incharge_name}</p>
          <p className="mt-2 text-sm text-muted">You are watching this bus. The QR code is on the incharge's screen.</p>
        </section>
      ) : <QrPanel trip={trip} kiosk={kiosk} setKiosk={setKiosk} sound={sound} setSound={setSound} />}

      <div className="flex min-w-0 flex-col gap-4">
        <section className="card p-5">
          <div className="flex items-end gap-3">
            <span key={bump} className="text-6xl font-extrabold tabular-nums text-ok animate-pop">{counts.boarded}</span>
            <span className="pb-2 text-muted">of {counts.expected} students verified</span>
          </div>
          <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-[linear-gradient(90deg,#1ea865,var(--color-ok))] transition-[width] duration-700 ease-[var(--ease-out)]" style={{ width: `${pct}%` }} /></div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>{directionLabel(trip.direction)} · started {fmtTime(trip.started_at)}</span>
            {counts.duplicates > 0 && <span className="pill pill-warn">{counts.duplicates} duplicate scans</span>}
            {counts.flagged > 0 && <span className="pill pill-warn">{counts.flagged} to review</span>}
          </div>
          {!user.readOnly && !kiosk && (
            <div className="mt-4 flex flex-wrap gap-2">
              <button className="btn" onClick={() => setManual(true)}><Icon name="edit" className="size-4" />Mark manually</button>
              <button className="btn btn-danger" onClick={end}><Icon name="stop" className="size-4" />End trip</button>
            </div>
          )}
        </section>

        {fresh && (
          <section key={fresh.id} className="card flex items-center gap-4 border-ok bg-ok-soft p-4 animate-pop" aria-live="polite">
            <Avatar src={fresh.photo_url} name={fresh.name} className="size-16 text-lg" />
            <div className="min-w-0">
              <div className="text-xs font-bold uppercase tracking-wide text-ok">✓ Just verified · {fmtTime(fresh.created_at)}</div>
              <div className="truncate text-xl font-bold text-navy">{fresh.name}</div>
              <div className="truncate text-sm text-muted">{fresh.uuid}{fresh.stop ? ` · ${fresh.stop}` : ''}</div>
            </div>
          </section>
        )}

        <section className="card">
          <div className="flex flex-wrap items-center gap-2 border-b border-line p-4">
            <h3 className="grow font-bold text-navy">Students on Bus {trip.bus_number}</h3>
            <div className="flex rounded-lg bg-page p-1 text-xs font-semibold">
              {[['all', `All ${done.length + pending.length}`], ['done', `Verified ${done.length}`], ['pending', `Not yet ${pending.length}`]].map(([k, label]) => (
                <button key={k} onClick={() => setFilter(k)} className={`rounded-md px-2.5 py-1.5 transition-all duration-200 ${filter === k ? 'bg-white text-brand shadow-sm' : 'text-muted hover:text-ink'}`}>{label}</button>
              ))}
            </div>
            {!kiosk && <input className="input mt-1 py-2" placeholder="Find by name, UUID or route" value={q} onChange={(e) => setQ(e.target.value)} />}
          </div>
          <ul className="max-h-[60vh] divide-y divide-line overflow-y-auto">
            {rows.length ? rows.map((r) => (
              <li key={`${r.at ? 'd' : 'p'}${r.id}`} className={`flex items-center gap-3 px-4 py-2.5 transition-colors duration-500 hover:bg-brand-soft/50 ${r.checkinId && r.checkinId === fresh?.id ? 'bg-ok-soft' : ''}`}>
                <Avatar src={r.photo_url} name={r.name} className="size-9 text-xs" />
                <div className="min-w-0 grow">
                  <div className="truncate text-sm font-semibold">{r.name} <span className="font-mono text-xs font-normal text-muted">{r.uuid}</span></div>
                  <div className="truncate text-xs text-muted">{[r.course, r.stop].filter(Boolean).join(' · ')} <FlagPills flags={(r.flags || '').replace(/(^|,)manual/, '')} /></div>
                </div>
                {r.at
                  ? <span className="pill pill-ok whitespace-nowrap">✓ {fmtTime(r.at)}{r.method === 'manual' ? ' · manual' : ''}</span>
                  : <span className="pill pill-muted">Not yet</span>}
              </li>
            )) : <li><Empty icon="users">{query ? 'No student matches.' : filter === 'done' ? 'Nobody has verified yet.' : filter === 'pending' ? 'Everyone on this bus has verified.' : 'No students are registered on this bus yet.'}</Empty></li>}
          </ul>
        </section>
      </div>
      {manual && <ManualCheckin trip={trip} onClose={() => setManual(false)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ QR */
function QrPanel({ trip, kiosk, setKiosk, sound, setSound }) {
  const toast = useToast();
  const [qr, setQr] = useState(null);
  const [err, setErr] = useState(null);
  const [left, setLeft] = useState(0);
  const timer = useRef(null);

  const fetchQr = useCallback(async () => {
    clearTimeout(timer.current);
    try {
      const q = await api.get(`/api/incharge/trips/${trip.id}/qr`);
      setQr(q); setErr(null);
      const nextAt = Date.now() + q.secondsLeft * 1000;
      setLeft(q.secondsLeft);
      timer.current = setTimeout(fetchQr, Math.max(1000, nextAt - Date.now() - (q.mode === 'rotating' ? 300 : 0)));
    } catch (e) {
      setErr(e.message);
      if (e.code !== 'TRIP_ENDED') timer.current = setTimeout(fetchQr, 4000);
    }
  }, [trip.id]);

  useEffect(() => {
    fetchQr();
    const onVis = () => { if (!document.hidden) fetchQr(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearTimeout(timer.current); document.removeEventListener('visibilitychange', onVis); };
  }, [fetchQr]);

  useEffect(() => {
    if (qr?.mode !== 'rotating') return undefined;
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [qr]);

  const toggleKiosk = async () => {
    const on = !kiosk;
    setKiosk(on);
    try { if (on) await document.documentElement.requestFullscreen?.(); else if (document.fullscreenElement) await document.exitFullscreen(); } catch { /* not allowed */ }
  };
  useEffect(() => {
    const onFs = () => { if (!document.fullscreenElement) setKiosk(false); };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, [setKiosk]);

  const newQr = async () => {
    if (!(await confirm({ title: 'Make a new QR code?', message: 'Every earlier QR of this bus (screens, prints, photos) stops working immediately.', okText: 'New QR code' }))) return;
    try { await api.post(`/api/incharge/trips/${trip.id}/new-qr`); toast('New QR code ready', 'success'); fetchQr(); } catch (e) { toast(e.message, 'error'); }
  };

  return (
    <section className={`card flex min-w-0 flex-col items-center p-5 text-center ${kiosk ? 'justify-center lg:min-h-[calc(100dvh-2rem)]' : ''}`}>
      <div className="flex w-full items-center justify-between gap-2">
        <span className="rounded-lg bg-uured px-3 py-1.5 text-lg font-extrabold text-white">BUS {trip.bus_number}</span>
        <span className="pill">{directionLabel(trip.direction)}</span>
      </div>
      <p className={`mt-4 font-bold text-navy ${kiosk ? 'text-3xl' : 'text-xl'}`}>Scan to verify</p>
      <p className="text-sm text-muted">Open the phone camera, scan, enter your UUID or enrollment number.</p>
      <div className={`relative mt-4 aspect-square w-full rounded-3xl border border-line bg-white p-4 shadow-[var(--shadow-lift)] animate-pop ${kiosk ? 'max-w-[min(78vh,640px)]' : 'max-w-[340px]'}`}>
        {qr ? <div className="size-full [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: qr.svg }} /> : <div className="flex size-full items-center justify-center"><Spinner className="size-8 text-brand" /></div>}
        {err && <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-white/90 p-4 text-sm font-semibold text-uured">{err}</div>}
      </div>
      {qr?.mode === 'rotating' ? (
        <div className="mt-3 w-full max-w-[340px]">
          <div className="h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-[linear-gradient(90deg,var(--color-brand-light),var(--color-brand))] transition-[width] duration-1000 ease-linear" style={{ width: `${(left / qr.rotateSec) * 100}%` }} /></div>
          <p className="mt-1 text-xs text-muted">New code in {left}s</p>
        </div>
      ) : qr ? <p className="mt-3 text-xs text-muted">Valid all day (until midnight). The same code works for every trip today.</p> : null}
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <button className="btn btn-sm" onClick={toggleKiosk}><Icon name="maximize" className="size-4" />{kiosk ? 'Exit full screen' : 'Full screen'}</button>
        <button className="btn btn-sm" onClick={() => setSound(!sound)} title="Beep when a student verifies"><Icon name={sound ? 'sound' : 'mute'} className="size-4" />{sound ? 'Sound on' : 'Sound off'}</button>
        {qr?.mode === 'day' && !kiosk && <button className="btn btn-sm" onClick={() => window.print()}><Icon name="file" className="size-4" />Print</button>}
        {qr?.mode === 'day' && !kiosk && <button className="btn btn-sm btn-ghost" onClick={newQr} title="Old codes stop working immediately"><Icon name="refresh" className="size-4" />New QR code</button>}
      </div>
    </section>
  );
}

function ManualCheckin({ trip, onClose }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim());
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const { data } = useFetch(query.length >= 2 ? `/api/incharge/students/search${qs({ q: query, bus: trip.bus_id })}` : null);
  const mark = async (s) => {
    setBusy(s.id); setError(null);
    try {
      await api.post(`/api/incharge/trips/${trip.id}/manual`, { uuid: s.uuid, note: note.trim() });
      toast(`${s.name} marked as verified`, 'success');
      onClose();
    } catch (e) { setError(e.message); setBusy(null); }
  };
  return (
    <Modal title="Mark a student manually" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">For a student whose phone is dead or lost. Manual marks are flagged and recorded with your name.</p>
        <input className="input" placeholder="Search name, UUID or enrollment no." value={q} onChange={(e) => setQ(e.target.value)} />
        <input className="input" placeholder="Reason (optional), e.g. phone battery dead" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        <ErrorText>{error}</ErrorText>
        <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-xl border border-line empty:hidden">
          {(query.length >= 2 ? data?.items || [] : []).map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-3 py-2">
              <Avatar src={s.photo_url} name={s.name} className="size-8 text-xs" />
              <div className="min-w-0 grow"><div className="truncate text-sm font-semibold">{s.name}</div><div className="truncate font-mono text-xs text-muted">{s.uuid}{s.stop ? ` · ${s.stop}` : ''}</div></div>
              <button className="btn btn-sm btn-primary" disabled={busy != null} onClick={() => mark(s)}>{busy === s.id ? <Spinner className="size-3" /> : 'Mark'}</button>
            </li>
          ))}
        </ul>
        {query.length >= 2 && data && !data.items.length && <p className="text-center text-sm text-muted">No student on Bus {trip.bus_number} matches.</p>}
      </div>
    </Modal>
  );
}

let audioCtx = null;
function beep() {
  try {
    audioCtx ||= new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.26);
  } catch { /* audio blocked until the first tap */ }
}
