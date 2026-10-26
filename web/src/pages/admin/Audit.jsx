import { useState } from 'react';
import { useFetch } from '../../lib/useFetch.js';
import { fmtDateTime } from '../../lib/format.js';
import { Empty, Loading } from '../../components/ui.jsx';

export default function Audit() {
  const [page, setPage] = useState(1);
  const { data, loading, error } = useFetch(`/api/admin/audit?page=${page}`);
  if (loading && !data) return <Loading />;
  if (error) return <div className="card"><Empty icon="alert">{error.message}</Empty></div>;
  const pages = Math.max(1, Math.ceil(data.total / data.limit));
  return (
    <div className="card">
      {data.items.length ? (
        <>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th><th>IP</th></tr></thead>
              <tbody>
                {data.items.map((a) => (
                  <tr key={a.id}>
                    <td className="whitespace-nowrap text-xs">{fmtDateTime(a.created_at)}</td>
                    <td className="text-xs font-semibold">{a.actor_name || '—'}</td>
                    <td><span className="pill pill-muted font-mono">{a.action}</span></td>
                    <td className="max-w-md text-xs">{a.details}</td>
                    <td className="font-mono text-xs text-muted">{a.ip}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3 text-sm text-muted">
            <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Newer</button>
            <span>Page {page} of {pages}</span>
            <button className="btn btn-sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Older</button>
          </div>
        </>
      ) : <Empty icon="audit">No activity yet.</Empty>}
    </div>
  );
}
