import { useMemo, useState, useTransition } from 'react';
import { api } from '../../lib/api.js';
import { fmtDate, fmtTime } from '../../lib/format.js';
import { Icon } from '../../components/Icon.jsx';
import { ErrorText, Spinner, copyText, saveBlob, useToast } from '../../components/ui.jsx';
import { readWorkbook, toInstant, TIMEZONES } from './excel.js';

/*
 * Import the Apps Script database workbook: buses, bus incharge accounts, students and (optionally)
 * the verification history. The file is read in the browser and previewed first; it can be limited
 * to one bus; only the needed columns are sent.
 */
export default function ImportData() {
  const toast = useToast();
  const [book, setBook] = useState(null);
  const [fileName, setFileName] = useState('');
  const [bus, setBus] = useState('');
  const [withHistory, setWithHistory] = useState(true);
  const [zone, setZone] = useState('Asia/Kolkata');
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [reading, startReading] = useTransition();
  const [saving, startSaving] = useTransition();

  const pick = (file) => {
    setError(null); setResult(null); setBook(null); setBus('');
    if (!file) return;
    setFileName(file.name);
    startReading(async () => {
      try { const b = await readWorkbook(file); setBook(b); setZone(b.zone); } catch (e) { setError(e.message || 'Could not read this file. Save it as .xlsx and try again.'); }
    });
  };

  // everything limited to the chosen bus (or all of it)
  const sel = useMemo(() => {
    if (!book) return null;
    const same = (v) => !bus || String(v).trim().toLowerCase() === bus.toLowerCase();
    const head = book.students[0] || [];
    const busCol = head.findIndex((h) => /^bus(no|number)?$/i.test(String(h).replace(/[^a-z]/gi, '')));
    const students = book.students.length ? [head, ...book.students.slice(1).filter((r) => busCol < 0 || same(r[busCol]))] : [];
    const logs = book.logs.filter((l) => same(l.bus)).map((l) => ({ ...l, at: toInstant(l.naive, zone) }));
    return {
      buses: book.buses.filter((b) => same(b.number)),
      incharges: book.incharges.filter((u) => String(u.role).toUpperCase() !== 'ADMIN' && same(u.bus)),
      students,
      logs,
      busList: [...new Set([...book.buses.map((b) => b.number), ...book.students.slice(1).map((r) => busCol >= 0 ? r[busCol] : '')].filter(Boolean))],
    };
  }, [book, bus, zone]);

  const run = () => startSaving(async () => {
    setError(null);
    try {
      const r = await api.post('/api/admin/import/workbook', {
        buses: sel.buses, incharges: sel.incharges, students: sel.students,
        verifications: withHistory ? sel.logs.map((l) => ({ uuid: l.uuid, bus: l.bus, status: l.status, at: l.at })) : [],
      });
      setResult(r);
      toast('Workbook imported', 'success');
    } catch (e) { setError(e.message); }
  });

  const studentRows = Math.max(0, (sel?.students.length || 0) - 1);
  const newAccounts = result?.incharges.created || [];
  const accountsText = newAccounts.map((u) => `${u.bus}\t${u.username}\t${u.password}`).join('\n');
  const logSpan = sel?.logs.length ? [Math.min(...sel.logs.map((l) => l.at)), Math.max(...sel.logs.map((l) => l.at))] : null;
  const verifiedLogs = sel?.logs.filter((l) => l.status === 'VERIFIED').length || 0;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <section className="card p-6">
        <h2 className="text-lg font-bold text-navy">Import the bus database workbook</h2>
        <p className="mt-2 text-sm text-muted">
          Choose your <b>United University Bus Database</b> Excel file (.xlsx). It reads the <b>Buses</b>, <b>Incharges</b>, <b>Students</b> and <b>VerificationLogs</b> sheets.
          Existing buses, accounts and students (same bus number, Login ID or UUID) are updated, never duplicated. PIN hashes from the sheet are not used:
          each new incharge account gets a fresh password, shown once below.
        </p>
        <label className="mt-5 flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-line bg-page px-6 py-8 text-center transition hover:border-brand">
          <Icon name="file" className="size-9 text-brand" />
          <span className="font-semibold">{fileName || 'Choose Excel workbook'}</span>
          <span className="text-xs text-muted">.xlsx · read on this device until you press Import</span>
          <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
        </label>
        {reading && <p className="mt-3 flex items-center gap-2 text-sm text-muted"><Spinner className="size-4" />Reading workbook…</p>}
        <div className="mt-3"><ErrorText>{error}</ErrorText></div>
      </section>

      {sel && !result && (
        <section className="card p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-bold text-navy">Ready to import</h3>
            <label className="flex items-center gap-2 text-sm font-semibold">Bus
              <select className="input w-auto py-1.5" value={bus} onChange={(e) => setBus(e.target.value)}>
                <option value="">All buses</option>
                {sel.busList.map((b) => <option key={b} value={b}>{b} only</option>)}
              </select>
            </label>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
            <Count n={sel.buses.length} label="buses" />
            <Count n={sel.incharges.length} label="incharge accounts" />
            <Count n={studentRows} label="students" />
            <Count n={withHistory ? sel.logs.length : 0} label="log rows" />
          </div>

          {sel.logs.length > 0 && (
            <div className="mt-4 rounded-xl border border-line p-4">
              <label className="flex items-start gap-3 text-sm">
                <input type="checkbox" className="mt-0.5 size-4 accent-brand" checked={withHistory} onChange={(e) => setWithHistory(e.target.checked)} />
                <span>
                  <b>Import the verification history</b>: {verifiedLogs} verified, {sel.logs.length - verifiedLogs} duplicate scans
                  {logSpan && <> on <b>{fmtDate(logSpan[0])}</b>, <b>{fmtTime(logSpan[0])} – {fmtTime(logSpan[1])}</b> India time</>}.
                  They appear on the dashboard and in Trips as an ended trip, marked "imported".
                </span>
              </label>
              {withHistory && (
                <label className="mt-3 flex flex-wrap items-center gap-2 pl-7 text-xs text-muted">Times in the sheet are in
                  <select className="input w-auto py-1 text-xs" value={zone} onChange={(e) => setZone(e.target.value)}>
                    {TIMEZONES.map(([z, l]) => <option key={z} value={z}>{l}{z === book.zone ? ' (detected)' : ''}</option>)}
                  </select>
                  <span>Check the India-time range above matches when the bus ran.</span>
                </label>
              )}
            </div>
          )}

          {sel.students.length > 1 && (
            <div className="table-wrap mt-4">
              <table className="tbl">
                <thead><tr>{sel.students[0].slice(0, 8).map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
                <tbody>{sel.students.slice(1, 6).map((r, i) => <tr key={i}>{sel.students[0].slice(0, 8).map((_h, j) => <td key={j} className="max-w-40 truncate text-xs">{r[j]}</td>)}</tr>)}</tbody>
              </table>
              {studentRows > 5 && <p className="p-2 text-center text-xs text-muted">…and {studentRows - 5} more students</p>}
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button className="btn" onClick={() => { setBook(null); setFileName(''); }}>Cancel</button>
            <button className="btn btn-primary" onClick={run} disabled={saving}>{saving ? <Spinner className="size-4" /> : <Icon name="upload" className="size-4" />}Import{bus ? ` ${bus}` : ''}</button>
          </div>
        </section>
      )}

      {result && (
        <section className="card p-6">
          <h3 className="font-bold text-ok">Import complete</h3>
          <ul className="mt-3 flex flex-col gap-1 text-sm">
            <li>Buses: <b>{result.buses.created}</b> added, <b>{result.buses.updated}</b> updated</li>
            <li>Incharge accounts: <b>{newAccounts.length}</b> created, <b>{result.incharges.updated}</b> updated</li>
            {result.students && <li>Students: <b>{result.students.inserted}</b> added, <b>{result.students.updated}</b> updated, <b>{result.students.skipped}</b> skipped ({result.students.stopsCreated} new routes)</li>}
            {result.verifications && <li>History: <b>{result.verifications.verified}</b> verifications and <b>{result.verifications.duplicates}</b> duplicate scans added ({result.verifications.trips} trips){result.verifications.skipped ? `, ${result.verifications.skipped} skipped` : ''}</li>}
          </ul>
          {[...(result.students?.errors || []), ...(result.verifications?.errors || [])].length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-xs text-uured">{[...(result.students?.errors || []), ...(result.verifications?.errors || [])].map((e) => <li key={e}>{e}</li>)}</ul>
          )}
          {newAccounts.length > 0 && (
            <div className="mt-5">
              <div className="rounded-lg bg-warn-soft p-3 text-sm font-semibold text-warn">Save these passwords now: they are shown only once. You can look any of them up later under Staff (eye button).</div>
              <div className="table-wrap mt-3">
                <table className="tbl">
                  <thead><tr><th>Bus</th><th>Login ID</th><th>Password</th><th>Portal</th></tr></thead>
                  <tbody>{newAccounts.map((u) => <tr key={u.username}><td className="font-semibold">{u.bus || '—'}</td><td className="font-mono">{u.username}</td><td className="font-mono font-bold">{u.password}</td><td className="font-mono text-xs">{u.portal}</td></tr>)}</tbody>
                </table>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button className="btn" onClick={() => copyText(accountsText, toast)}><Icon name="copy" className="size-4" />Copy</button>
                <button className="btn" onClick={() => saveBlob(new Blob([['bus,login_id,password,portal', ...newAccounts.map((u) => [u.bus, u.username, u.password, location.origin + u.portal].join(','))].join('\r\n') + '\r\n'], { type: 'text/csv' }), 'incharge-accounts.csv')}><Icon name="download" className="size-4" />Download CSV</button>
              </div>
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button className="btn" onClick={() => { setResult(null); setBook(null); setFileName(''); }}>Import another file</button>
            <a className="btn btn-primary" href="#dashboard">Go to dashboard</a>
          </div>
        </section>
      )}
    </div>
  );
}

function Count({ n, label }) {
  return <div className="rounded-xl bg-page p-3"><div className="text-2xl font-extrabold text-brand">{n}</div><div className="text-xs text-muted">{label}</div></div>;
}
