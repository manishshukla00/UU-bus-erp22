import { useActionState, useDeferredValue, useState } from 'react';
import { api, qs } from '../../lib/api.js';
import { useFetch } from '../../lib/useFetch.js';
import { useSession } from '../../lib/session.jsx';
import { fmtDateTime, directionLabel } from '../../lib/format.js';
import { Icon } from '../../components/Icon.jsx';
import { Avatar, Empty, ErrorText, Field, FlagPills, Loading, Modal, SubmitButton, confirm, downloadFile, saveBlob, useToast } from '../../components/ui.jsx';
import { readStudentsFile } from './excel.js';

export default function Students() {
  const { user } = useSession();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [bus, setBus] = useState('');
  const [page, setPage] = useState(1);
  const query = useDeferredValue(q.trim());
  const { data, loading, error, reload } = useFetch(`/api/admin/students${qs({ q: query, bus, page, limit: 50 })}`);
  const buses = useFetch('/api/admin/buses');
  const [edit, setEdit] = useState(null); // {} = new, student = edit
  const [history, setHistory] = useState(null);
  const [importing, setImporting] = useState(false);
  const busList = buses.data?.buses || [];
  const ro = user.readOnly;

  const remove = async (s) => {
    if (!(await confirm({ title: 'Remove student?', message: `${s.name} (${s.uuid}) will be removed. Students with boarding history are deactivated instead, so reports stay complete.`, okText: 'Remove', danger: true }))) return;
    try {
      const r = await api.del(`/api/admin/students/${s.id}`);
      toast(r.deactivated ? `${s.name} deactivated (has boarding history)` : `${s.name} removed`, 'success');
      reload();
    } catch (e) { toast(e.message, 'error'); }
  };

  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-72">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input className="input pl-9" placeholder="Name, UUID, enrollment no., course" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </div>
        <select className="input w-auto" value={bus} onChange={(e) => { setBus(e.target.value); setPage(1); }} aria-label="Bus">
          <option value="">All buses</option>
          <option value="none">No bus</option>
          {busList.map((b) => <option key={b.id} value={b.id}>{b.number}{b.active ? '' : ' (inactive)'}</option>)}
        </select>
        <div className="grow" />
        {!ro && <button className="btn" onClick={() => setImporting(true)}><Icon name="upload" className="size-4" />Import</button>}
        {!ro && <button className="btn" onClick={() => downloadFile('/api/admin/students/export.csv', 'students.csv').catch((e) => toast(e.message, 'error'))}><Icon name="download" className="size-4" />Export</button>}
        {!ro && <button className="btn btn-primary" onClick={() => setEdit({})}><Icon name="plus" className="size-4" />Add student</button>}
      </div>

      <div className="card">
        {loading && !data ? <Loading /> : error ? <Empty icon="alert">{error.message}</Empty> : data.items.length ? (
          <>
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>Student</th><th>UUID</th><th>Enrollment no.</th><th>Bus</th><th>Route</th><th>Course</th><th></th></tr></thead>
                <tbody>
                  {data.items.map((s) => (
                    <tr key={s.id} className={s.active ? '' : 'opacity-55'}>
                      <td><div className="flex items-center gap-3"><Avatar src={s.photo_url} name={s.name} className="size-9 text-xs" /><div className="font-semibold">{s.name}{!s.active && <span className="pill pill-muted ml-2">Inactive</span>}</div></div></td>
                      <td className="font-mono text-xs">{s.uuid}</td>
                      <td className="font-mono text-xs">{s.enrollment_no || '—'}</td>
                      <td className="whitespace-nowrap font-semibold">{s.bus_number || <span className="text-muted">—</span>}</td>
                      <td className="max-w-52 truncate text-xs" title={s.stop_name}>{s.stop_name || '—'}</td>
                      <td className="max-w-52 truncate text-xs" title={s.course}>{s.course}</td>
                      <td className="whitespace-nowrap text-right">
                        <button className="btn btn-ghost btn-icon" title="Boarding history" onClick={() => setHistory(s)}><Icon name="clock" className="size-4" /></button>
                        {!ro && <button className="btn btn-ghost btn-icon" title="Edit" onClick={() => setEdit(s)}><Icon name="edit" className="size-4" /></button>}
                        {!ro && <button className="btn btn-ghost btn-icon hover:text-uured" title="Remove" onClick={() => remove(s)}><Icon name="trash" className="size-4" /></button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm text-muted">
              <span>{data.total} students</span>
              <div className="flex items-center gap-2">
                <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
                <span>Page {page} of {pages}</span>
                <button className="btn btn-sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</button>
              </div>
            </div>
          </>
        ) : <Empty icon="users">{query || bus ? 'No students match.' : 'No students yet. Import your Excel workbook (Import Excel) or a CSV, or add them one by one.'}</Empty>}
      </div>

      {edit && <StudentForm student={edit.id ? edit : null} buses={busList} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
      {history && <History student={history} onClose={() => setHistory(null)} canReset={!ro} />}
      {importing && <ImportStudents onClose={() => setImporting(false)} onDone={() => { reload(); buses.reload(); }} />}
    </div>
  );
}

function StudentForm({ student, buses, onClose, onSaved }) {
  const toast = useToast();
  const [busId, setBusId] = useState(student?.bus_id ?? '');
  const [photo, setPhoto] = useState(student?.photo_url || '');
  const selfie = photo.startsWith('/api/photos/');
  const stops = buses.find((b) => String(b.id) === String(busId))?.stops || [];
  const [error, action, pending] = useActionState(async (_p, f) => {
    const body = {
      uuid: f.get('uuid'), enrollment_no: f.get('enrollment_no'), name: f.get('name'), photo_url: String(f.get('photo_url') || '').trim(),
      course: f.get('course'), year: f.get('year'), specialization: f.get('specialization'), phone: f.get('phone'),
      bus_id: f.get('bus_id') || null, stop_id: f.get('stop_id') || null, active: f.get('active') === 'on',
    };
    try {
      if (student) await api.put(`/api/admin/students/${student.id}`, body); else await api.post('/api/admin/students', body);
      toast(student ? 'Student saved' : 'Student added', 'success');
      onSaved();
      return null;
    } catch (e) { return e.message; }
  }, null);
  return (
    <Modal title={student ? `Edit ${student.name}` : 'Add student'} onClose={onClose} wide>
      <form action={action} className="grid grid-cols-1 gap-4 sm:grid-cols-2" autoComplete="off">
        <Field label="UUID"><input className="input font-mono uppercase" name="uuid" defaultValue={student?.uuid} required maxLength={40} /></Field>
        <Field label="Enrollment number" help="Students can verify with either number."><input className="input font-mono uppercase" name="enrollment_no" defaultValue={student?.enrollment_no} maxLength={40} /></Field>
        <Field label="Student name" className="sm:col-span-2"><input className="input" name="name" defaultValue={student?.name} required maxLength={80} /></Field>
        <Field label="Photo" help={selfie ? 'Selfie the student took at verification. Remove it and they take a new one next time.' : 'A public https link to the photo, or leave empty: the student is asked for a selfie at their next verification.'} className="sm:col-span-2">
          <div className="flex items-center gap-3">
            <Avatar src={photo} name={student?.name || '?'} className="size-12 text-sm" />
            {selfie
              ? <><input type="hidden" name="photo_url" value={photo} /><span className="pill pill-ok">Selfie on file</span></>
              : <input className="input" name="photo_url" type="text" inputMode="url" placeholder="https://example.com/student.jpg" value={photo} onChange={(e) => setPhoto(e.target.value)} maxLength={500} />}
            {photo && <button type="button" className="btn btn-sm shrink-0" onClick={() => setPhoto('')}>Remove photo</button>}
          </div>
        </Field>
        <Field label="Bus">
          <select className="input" name="bus_id" value={busId} onChange={(e) => setBusId(e.target.value)}>
            <option value="">No bus</option>
            {buses.map((b) => <option key={b.id} value={b.id}>{b.number}{b.active ? '' : ' (inactive)'}</option>)}
          </select>
        </Field>
        <Field label="Route / pickup point">
          <select className="input" name="stop_id" defaultValue={student?.stop_id ?? ''} key={busId} disabled={!busId}>
            <option value="">—</option>
            {stops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Course" className="sm:col-span-2"><input className="input" name="course" defaultValue={student?.course} maxLength={80} /></Field>
        <Field label="Year"><input className="input" name="year" defaultValue={student?.year} maxLength={20} /></Field>
        <Field label="Specialization"><input className="input" name="specialization" defaultValue={student?.specialization} maxLength={80} /></Field>
        <Field label="Phone"><input className="input" name="phone" defaultValue={student?.phone} maxLength={20} inputMode="tel" /></Field>
        <label className="flex items-center gap-2 self-end pb-3 text-sm font-semibold"><input type="checkbox" name="active" defaultChecked={student ? !!student.active : true} className="size-4 accent-brand" />Active</label>
        <div className="sm:col-span-2"><ErrorText>{error}</ErrorText></div>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <SubmitButton pending={pending}>Save student</SubmitButton>
        </div>
      </form>
    </Modal>
  );
}

function History({ student, onClose, canReset }) {
  const toast = useToast();
  const { data, loading, reload } = useFetch(`/api/admin/students/${student.id}/history`);
  const reset = async () => {
    if (!(await confirm({ title: 'Reset phones?', message: `Unlink every phone from ${student.name}. Their next verification binds a new phone.`, okText: 'Reset phones' }))) return;
    try { const r = await api.post(`/api/admin/students/${student.id}/devices/reset`); toast(`${r.unlinked} phone(s) unlinked`, 'success'); reload(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <Modal title={`${student.name} · history`} onClose={onClose} wide>
      {loading ? <Loading /> : (
        <div className="flex flex-col gap-5">
          <div>
            <div className="mb-2 flex items-center justify-between"><h3 className="font-bold text-navy">Phones</h3>{canReset && data.devices.length > 0 && <button className="btn btn-sm" onClick={reset}>Reset phones</button>}</div>
            {data.devices.length ? (
              <ul className="flex flex-col gap-2 text-sm">{data.devices.map((d) => <li key={d.id} className="rounded-lg bg-page px-3 py-2"><span className="font-mono text-xs">{d.id}</span> · bound {fmtDateTime(d.bound_at)} · last seen {fmtDateTime(d.last_seen)}<div className="truncate text-xs text-muted">{d.ua}</div></li>)}</ul>
            ) : <p className="text-sm text-muted">No phone linked yet.</p>}
          </div>
          <div>
            <h3 className="mb-2 font-bold text-navy">Recent boardings</h3>
            {data.items.length ? (
              <div className="table-wrap"><table className="tbl"><thead><tr><th>When</th><th>Bus</th><th>Trip</th><th>How</th></tr></thead>
                <tbody>{data.items.map((c) => <tr key={c.id}><td>{fmtDateTime(c.created_at)}</td><td>{c.bus_number}</td><td>{directionLabel(c.direction)}</td><td>{c.method === 'manual' ? 'Manual' : 'QR'} <FlagPills flags={c.flags.replace(/(^|,)manual/, '')} /></td></tr>)}</tbody></table></div>
            ) : <p className="text-sm text-muted">No boardings yet.</p>}
          </div>
        </div>
      )}
    </Modal>
  );
}

const TEMPLATE = 'UUID,Name,PhotoURL,Route,BusNo,Course,EnrollmentNo,Active\r\nUU-UUID-0001,Sample Student,,Route A,UU-10,BCA,ENR0001,TRUE\r\n';

function ImportStudents({ onClose, onDone }) {
  const [result, setResult] = useState(null);
  const [error, action, pending] = useActionState(async (_p, f) => {
    const file = f.get('file');
    if (!file?.size) return 'Choose a CSV or Excel file first.';
    try {
      const body = /\.xlsx$/i.test(file.name) ? { rows: await readStudentsFile(file) } : { csv: await file.text() };
      setResult(await api.post('/api/admin/students/import', body));
      onDone();
      return null;
    } catch (e) { return e.message; }
  }, null);
  return (
    <Modal title="Import students" onClose={onClose}>
      {result ? (
        <div className="flex flex-col gap-3 text-sm">
          <div className="rounded-lg bg-ok-soft p-3 font-semibold text-ok">Added {result.inserted} · Updated {result.updated} · Skipped {result.skipped}</div>
          <p className="text-muted">{result.busesCreated} new buses, {result.stopsCreated} new routes{result.inactive ? `, ${result.inactive} marked inactive` : ''}.</p>
          {result.errors.length > 0 && <ul className="list-disc pl-5 text-xs text-uured">{result.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
          <div className="flex justify-end"><button className="btn btn-primary" onClick={onClose}>Done</button></div>
        </div>
      ) : (
        <form action={action} className="flex flex-col gap-4">
          <p className="text-sm text-muted">Required columns: <b>UUID</b>, <b>Name</b> and <b>BusNo</b>. Optional: PhotoURL, Route, Course, EnrollmentNo, Active. An Excel file uses its <b>Students</b> sheet (or the first sheet). Existing UUIDs are updated, not duplicated.</p>
          <input type="file" name="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="input" required />
          <ErrorText>{error}</ErrorText>
          <div className="flex flex-wrap justify-between gap-2">
            <button type="button" className="btn" onClick={() => saveBlob(new Blob([TEMPLATE], { type: 'text/csv' }), 'UU_Students_Template.csv')}><Icon name="download" className="size-4" />Template</button>
            <SubmitButton pending={pending}><Icon name="upload" className="size-4" />Import</SubmitButton>
          </div>
        </form>
      )}
    </Modal>
  );
}
