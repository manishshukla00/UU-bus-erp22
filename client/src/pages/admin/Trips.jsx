import { useState } from 'react';
import { api, qs } from '../../lib/api.js';
import { useFetch } from '../../lib/useFetch.js';
import { useSession } from '../../lib/session.jsx';
import { fmtTime, fmtDateTime, directionLabel, todayIso } from '../../lib/format.js';
import { Icon } from '../../components/Icon.jsx';
import { Avatar, Empty, FlagPills, Loading, Modal, confirm, downloadFile, useToast } from '../../components/ui.jsx';

export default function Trips() {
  const [date, setDate] = useState(todayIso());
  const [bus, setBus] = useState('');
  const buses = useFetch('/api/admin/buses');
  const { data, loading, error, reload } = useFetch(`/api/admin/trips${qs({ date, bus })}`);
  const [open, setOpen] = useState(null);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <input type="date" className="input w-auto" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value || todayIso())} aria-label="Day" />
        <select className="input w-auto" value={bus} onChange={(e) => setBus(e.target.value)} aria-label="Bus">
          <option value="">All buses</option>
          {(buses.data?.buses || []).map((b) => <option key={b.id} value={b.id}>{b.number}</option>)}
        </select>
      </div>
      <div className="card">
        {loading && !data ? <Loading /> : error ? <Empty icon="alert">{error.message}</Empty> : data.items.length ? (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Bus</th><th>Trip</th><th>Started</th><th>Ended</th><th>Incharge</th><th>Verified</th><th></th></tr></thead>
              <tbody>
                {data.items.map((t) => (
                  <tr key={t.id}>
                    <td className="whitespace-nowrap font-bold">{t.bus_number}</td>
                    <td>{directionLabel(t.direction)}</td>
                    <td className="tabular-nums">{fmtTime(t.started_at)}</td>
                    <td className="tabular-nums">{t.status === 'active' ? <span className="pill pill-ok">Running</span> : fmtTime(t.ended_at)}</td>
                    <td className="text-xs">{t.incharge_name}</td>
                    <td><b>{t.boarded}</b> <span className="text-muted">/ {t.expected}</span>{t.flagged > 0 && <span className="pill pill-warn ml-2">{t.flagged} flagged</span>}</td>
                    <td className="text-right"><button className="btn btn-sm" onClick={() => setOpen(t.id)}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty icon="trips">No trips on this day.</Empty>}
      </div>
      {open && <TripDetail id={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}

function TripDetail({ id, onClose, onChanged }) {
  const { user } = useSession();
  const toast = useToast();
  const { data, loading, reload } = useFetch(`/api/admin/trips/${id}`);
  const end = async () => {
    if (!(await confirm({ title: 'End this trip?', message: 'Its QR stops working immediately.', okText: 'End trip', danger: true }))) return;
    try { await api.post(`/api/admin/trips/${id}/end`); toast('Trip ended', 'success'); reload(); onChanged(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <Modal wide title={data ? `Bus ${data.trip.bus_number} · ${directionLabel(data.trip.direction)}` : 'Trip'} onClose={onClose}
      footer={data && <>
        {!user.readOnly && <button className="btn" onClick={() => downloadFile(`/api/admin/trips/${id}/export.csv`, 'trip.csv').catch((e) => toast(e.message, 'error'))}><Icon name="download" className="size-4" />CSV</button>}
        {!user.readOnly && data.trip.status === 'active' && <button className="btn btn-danger" onClick={end}>End trip</button>}
        <button className="btn btn-primary" onClick={onClose}>Close</button></>}>
      {loading || !data ? <Loading /> : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">Started {fmtDateTime(data.trip.started_at)} by {data.trip.incharge_name}{data.trip.ended_at ? `, ended ${fmtTime(data.trip.ended_at)}` : ''}. <b className="text-ok">{data.counts.boarded}</b> of {data.counts.expected} verified{data.counts.duplicates ? `, ${data.counts.duplicates} duplicate scans` : ''}.</p>
          <div>
            <h3 className="mb-2 font-bold text-navy">Verified ({data.checkins.length})</h3>
            {data.checkins.length ? (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {data.checkins.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <Avatar src={c.photo_url} name={c.name} className="size-8 text-xs" />
                    <div className="min-w-0 grow"><div className="font-semibold">{c.name}</div><div className="truncate text-xs text-muted">{c.uuid} · {c.stop || '—'}</div></div>
                    <FlagPills flags={c.flags} /><span className="tabular-nums text-xs text-muted">{fmtTime(c.created_at)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted">Nobody verified on this trip.</p>}
          </div>
          {data.notBoarded.length > 0 && (
            <div>
              <h3 className="mb-2 font-bold text-navy">Not verified ({data.notBoarded.length})</h3>
              <div className="flex flex-wrap gap-1.5">{data.notBoarded.map((s) => <span key={s.id} className="pill pill-muted" title={s.uuid}>{s.name}</span>)}</div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
