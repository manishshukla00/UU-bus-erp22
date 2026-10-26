import { useState } from 'react';
import { qs } from '../../lib/api.js';
import { useFetch } from '../../lib/useFetch.js';
import { fmtTime, directionLabel, todayIso } from '../../lib/format.js';
import { Empty, FlagPills, Loading } from '../../components/ui.jsx';

/** Verifications worth a second look: manual marks and first use of a new phone. */
export default function Flags() {
  const [date, setDate] = useState(todayIso());
  const { data, loading, error } = useFetch(`/api/admin/flags${qs({ date })}`);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <input type="date" className="input w-auto" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value || todayIso())} aria-label="Day" />
        <p className="text-sm text-muted">Manual check-ins and first verification from a new phone.</p>
      </div>
      <div className="card">
        {loading && !data ? <Loading /> : error ? <Empty icon="alert">{error.message}</Empty> : data.items.length ? (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Time</th><th>Student</th><th>Bus</th><th>Trip</th><th>Flags</th><th>Note</th></tr></thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id}>
                    <td className="tabular-nums">{fmtTime(c.created_at)}</td>
                    <td><div className="font-semibold">{c.name}</div><div className="font-mono text-xs text-muted">{c.uuid}</div></td>
                    <td className="whitespace-nowrap font-bold">{c.bus_number}</td>
                    <td className="text-xs">{directionLabel(c.direction)}</td>
                    <td><FlagPills flags={c.flags} /></td>
                    <td className="text-xs text-muted">{[c.marked_by_name && `by ${c.marked_by_name}`, c.note].filter(Boolean).join(' · ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty icon="flag">Nothing flagged on this day.</Empty>}
      </div>
    </div>
  );
}
