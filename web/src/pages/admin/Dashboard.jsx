import { useDeferredValue, useMemo, useRef, useState } from 'react';
import { qs } from '../../lib/api.js';
import { useFetch } from '../../lib/useFetch.js';
import { useLive, useThrottled } from '../../lib/live.js';
import { fmtTime, fmtDate, directionLabel, todayIso } from '../../lib/format.js';
import { Icon } from '../../components/Icon.jsx';
import { Avatar, Empty, FlagPills, LiveBadge, Loading, Stat, downloadFile, useToast } from '../../components/ui.jsx';

/*
 * Today at a glance: per-bus "verified of active students" with duplicates (as on the Apps Script
 * dashboard) and the full list of students verified today, live.
 */
export default function Dashboard() {
  const toast = useToast();
  const [date, setDate] = useState(todayIso());
  const [bus, setBus] = useState('');
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim().toLowerCase());
  const isToday = date === todayIso();
  const { data, error, loading, reload } = useFetch(`/api/admin/today${qs({ date: isToday ? '' : date })}`);

  // live: refetch (throttled) when anything is verified, scanned twice, started or ended
  const fresh = useRef(new Map());
  const refetch = useThrottled(reload, 1000);
  const live = useLive({
    checkin: (d) => { fresh.current.set(`c${d.checkin.id}`, Date.now()); if (isToday) refetch(); },
    duplicate: () => { if (isToday) refetch(); },
    trip: () => { if (isToday) refetch(); },
  });

  const rows = useMemo(() => {
    if (!data) return [];
    const all = [
      ...data.verified.map((c) => ({ ...c, key: `c${c.id}`, status: c.method === 'manual' ? 'manual' : 'verified' })),
      ...data.duplicates.map((d) => ({ ...d, key: `d${d.id}`, status: 'duplicate' })),
    ].sort((a, b) => b.created_at - a.created_at);
    return all.filter((r) => (!bus || r.bus_number === bus)
      && (status === 'all' || (status === 'verified' ? r.status !== 'duplicate' : r.status === status))
      && (!query || `${r.name} ${r.uuid} ${r.enrollment_no} ${r.stop || ''} ${r.course || ''}`.toLowerCase().includes(query)));
  }, [data, bus, status, query]);

  if (loading && !data) return <Loading />;
  if (error && !data) return <div className="card"><Empty icon="alert">{error.message}</Empty></div>;
  const { totals, buses } = data;
  const verifiedRows = rows.filter((r) => r.status !== 'duplicate');
  const verifiedCount = verifiedRows.length;
  // a student on both the morning and the evening trip is one student, two verifications
  const studentCount = new Set(verifiedRows.map((r) => r.student_id)).size;
  const pct = totals.students ? Math.round((totals.verified / totals.students) * 100) : 0;
  const shownBus = buses.find((b) => b.number === bus);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <input type="date" className="input w-auto" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value || todayIso())} aria-label="Day" />
        {!isToday && <button className="btn btn-sm" onClick={() => setDate(todayIso())}>Back to today</button>}
        <div className="grow" />
        {isToday && <LiveBadge ok={live} />}
        <button className="btn btn-sm" onClick={reload}><Icon name="refresh" className="size-4" />Refresh</button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={isToday ? 'Verified today' : 'Verified'} value={totals.verified} sub={`of ${totals.students} active students · ${pct}%`} tone="ok" icon="checkCircle" />
        <Stat label="Boardings" value={totals.boardings} sub="all trips, morning and evening" icon="bus" />
        <Stat label="Duplicates" value={totals.duplicates} sub="repeat scans, already verified" tone={totals.duplicates ? 'warn' : 'navy'} icon="repeat" />
        <Stat label="Running trips" value={totals.live} sub={`${buses.length} active buses`} tone="navy" icon="trips" />
      </div>

      <section className="card p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold text-navy">{isToday ? "Today's" : fmtDate(data.start + 1)} bus statistics</h2>
          {bus && <button className="btn btn-sm" onClick={() => setBus('')}><Icon name="x" className="size-4" />Show all buses</button>}
        </div>
        {buses.length ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {buses.map((b) => {
              const p = b.students ? Math.min(100, Math.round((b.verified / b.students) * 100)) : 0;
              return (
                <button key={b.id} onClick={() => setBus(bus === b.number ? '' : b.number)}
                  className={`rounded-xl border p-4 text-left transition hover:border-brand ${bus === b.number ? 'border-brand bg-brand-soft' : 'border-line bg-[#f7faff]'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-navy">{b.number}</span>
                    {b.live_trip ? <span className="pill pill-ok"><span className="size-1.5 rounded-full bg-ok animate-pulse" />{directionLabel(b.live_direction)}</span> : <span className="pill pill-muted">No trip</span>}
                  </div>
                  <div className="my-2 text-3xl font-extrabold tabular-nums text-brand">{b.verified}</div>
                  <div className="text-xs text-muted">Verified of {b.students} active students</div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-ok transition-all" style={{ width: `${p}%` }} /></div>
                  <div className="mt-2 flex justify-between text-xs text-muted">
                    <span>Duplicates: <b className={b.duplicates ? 'text-warn' : ''}>{b.duplicates}</b></span>
                    <span className="truncate pl-2" title={b.route}>{b.route}</span>
                  </div>
                </button>
              );
            })}
          </div>
        ) : <Empty icon="bus">No active buses. Import your Excel workbook or add buses under Buses &amp; routes.</Empty>}
      </section>

      <section className="card">
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-5">
          <div className="grow">
            <h2 className="text-lg font-bold text-navy">{isToday ? "Today's verified students" : `Verified on ${fmtDate(data.start + 1)}`}{shownBus ? ` · ${shownBus.number}` : ''}</h2>
            <p className="text-sm text-muted">
              <b className="text-ok">{studentCount}</b> {studentCount === 1 ? 'student' : 'students'} verified
              {verifiedCount !== studentCount ? ` · ${verifiedCount} verifications (morning + evening)` : ''}
              {rows.length !== verifiedCount ? ` · ${rows.length - verifiedCount} duplicate scans` : ''}
            </p>
          </div>
          <div className="relative w-full sm:w-64">
            <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <input className="input pl-9" placeholder="Search name, UUID, route…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <select className="input w-auto" value={bus} onChange={(e) => setBus(e.target.value)} aria-label="Bus">
            <option value="">All buses</option>
            {buses.map((b) => <option key={b.id} value={b.number}>{b.number}</option>)}
          </select>
          <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="all">All scans</option>
            <option value="verified">Verified only</option>
            <option value="duplicate">Duplicates only</option>
            <option value="manual">Manual only</option>
          </select>
          <button className="btn" onClick={() => downloadFile(`/api/admin/today/export.csv${qs({ date: isToday ? '' : date, bus: shownBus?.id })}`, 'verified.csv').catch((e) => toast(e.message, 'error'))}>
            <Icon name="download" className="size-4" />CSV
          </button>
        </div>
        {rows.length ? (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Time</th><th>Student</th><th>UUID / Enrollment</th><th>Bus</th><th>Trip</th><th>Route</th><th>Status</th></tr></thead>
              <tbody>
                {rows.slice(0, 1000).map((r) => {
                  const isNew = Date.now() - (fresh.current.get(r.key) || 0) < 8000;
                  return (
                    <tr key={r.key} className={isNew ? 'bg-ok-soft animate-fade' : ''}>
                      <td className="whitespace-nowrap tabular-nums text-muted">{fmtTime(r.created_at)}</td>
                      <td><div className="flex items-center gap-3"><Avatar src={r.photo_url} name={r.name} className="size-9 text-xs" /><div><div className="font-semibold">{r.name}</div><div className="text-xs text-muted">{r.course}</div></div></div></td>
                      <td className="font-mono text-xs">{r.uuid}{r.enrollment_no && r.enrollment_no !== r.uuid ? <div className="text-muted">{r.enrollment_no}</div> : null}</td>
                      <td className="whitespace-nowrap font-semibold">{r.bus_number}</td>
                      <td className="whitespace-nowrap text-xs">{directionLabel(r.direction)}</td>
                      <td className="max-w-48 truncate text-xs" title={r.stop}>{r.stop || '—'}</td>
                      <td className="whitespace-nowrap">
                        {r.status === 'duplicate' ? <span className="pill pill-warn">Duplicate</span>
                          : r.status === 'manual' ? <span className="pill" title={r.marked_by_name ? `Marked by ${r.marked_by_name}` : ''}>Manual</span>
                            : <span className="pill pill-ok">✓ Verified</span>}
                        {' '}<FlagPills flags={r.status === 'duplicate' ? '' : (r.flags || '').replace(/(^|,)manual/, '')} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length > 1000 && <p className="p-3 text-center text-xs text-muted">Showing the latest 1,000. Download the CSV for all {rows.length}.</p>}
          </div>
        ) : <Empty icon="users">{query || bus || status !== 'all' ? 'No scans match these filters.' : isToday ? 'No students verified yet today. They appear here the moment they verify.' : 'No verifications on this day.'}</Empty>}
      </section>
    </div>
  );
}
