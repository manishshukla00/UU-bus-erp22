import { useState, useTransition } from 'react';
import { api } from '../../lib/api.js';
import { Icon } from '../../components/Icon.jsx';
import { ErrorText, Spinner, copyText, saveBlob, useToast } from '../../components/ui.jsx';
import { readWorkbook } from './excel.js';

/*
 * Import the whole Apps Script database workbook in one go: buses, bus incharge accounts and
 * students. The file is read in the browser and previewed first; only the needed columns are sent.
 */
export default function ImportData() {
  const toast = useToast();
  const [book, setBook] = useState(null);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [reading, startReading] = useTransition();
  const [saving, startSaving] = useTransition();

  const pick = (file) => {
    setError(null); setResult(null); setBook(null);
    if (!file) return;
    setFileName(file.name);
    startReading(async () => {
      try { setBook(await readWorkbook(file)); } catch (e) { setError(e.message || 'Could not read this file. Save it as .xlsx and try again.'); }
    });
  };

  const run = () => startSaving(async () => {
    setError(null);
    try {
      const r = await api.post('/api/admin/import/workbook', { buses: book.buses, incharges: book.incharges, students: book.students });
      setResult(r);
      toast('Workbook imported', 'success');
    } catch (e) { setError(e.message); }
  });

  const studentRows = Math.max(0, (book?.students.length || 0) - 1);
  const newAccounts = result?.incharges.created || [];
  const accountsText = newAccounts.map((u) => `${u.bus}\t${u.username}\t${u.password}`).join('\n');

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <section className="card p-6">
        <h2 className="text-lg font-bold text-navy">Import the bus database workbook</h2>
        <p className="mt-2 text-sm text-muted">
          Choose your <b>United University Bus Database</b> Excel file (.xlsx). It reads the <b>Buses</b>, <b>Incharges</b> and <b>Students</b> sheets.
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

      {book && !result && (
        <section className="card p-6">
          <h3 className="font-bold text-navy">Ready to import</h3>
          <div className="mt-4 grid grid-cols-3 gap-3 text-center">
            <Count n={book.buses.length} label="buses" />
            <Count n={book.incharges.filter((u) => String(u.role).toUpperCase() !== 'ADMIN').length} label="incharge accounts" />
            <Count n={studentRows} label="students" />
          </div>
          {book.students.length > 1 && (
            <div className="table-wrap mt-4">
              <table className="tbl">
                <thead><tr>{book.students[0].slice(0, 8).map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
                <tbody>{book.students.slice(1, 6).map((r, i) => <tr key={i}>{book.students[0].slice(0, 8).map((_h, j) => <td key={j} className="max-w-40 truncate text-xs">{r[j]}</td>)}</tr>)}</tbody>
              </table>
              {studentRows > 5 && <p className="p-2 text-center text-xs text-muted">…and {studentRows - 5} more students</p>}
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button className="btn" onClick={() => { setBook(null); setFileName(''); }}>Cancel</button>
            <button className="btn btn-primary" onClick={run} disabled={saving}>{saving ? <Spinner className="size-4" /> : <Icon name="upload" className="size-4" />}Import</button>
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
          </ul>
          {result.students?.errors?.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-uured">{result.students.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
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
