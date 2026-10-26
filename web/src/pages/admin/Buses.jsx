import { useActionState, useState } from 'react';
import { api } from '../../lib/api.js';
import { useFetch } from '../../lib/useFetch.js';
import { useSession } from '../../lib/session.jsx';
import { Link } from '../../lib/router.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Empty, ErrorText, Field, Loading, Modal, SubmitButton, confirm, useToast } from '../../components/ui.jsx';

export default function Buses() {
  const { user } = useSession();
  const toast = useToast();
  const { data, loading, error, reload } = useFetch('/api/admin/buses');
  const [edit, setEdit] = useState(null);
  const ro = user.readOnly;

  const remove = async (b) => {
    if (!(await confirm({ title: `Remove bus ${b.number}?`, message: 'A bus with trip history is deactivated instead of deleted. Its students keep their records.', okText: 'Remove', danger: true }))) return;
    try { const r = await api.del(`/api/admin/buses/${b.id}`); toast(r.deactivated ? `Bus ${b.number} deactivated` : `Bus ${b.number} removed`, 'success'); reload(); } catch (e) { toast(e.message, 'error'); }
  };
  const addStop = async (b, name) => {
    try { await api.post(`/api/admin/buses/${b.id}/stops`, { name }); reload(); } catch (e) { toast(e.message, 'error'); }
  };
  const removeStop = async (s) => {
    if (!(await confirm({ title: 'Remove route stop?', message: `"${s.name}" will be removed; students on it keep their bus.`, okText: 'Remove', danger: true }))) return;
    try { await api.del(`/api/admin/stops/${s.id}`); reload(); } catch (e) { toast(e.message, 'error'); }
  };

  if (loading && !data) return <Loading />;
  if (error) return <div className="card"><Empty icon="alert">{error.message}</Empty></div>;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="grow text-sm text-muted">{data.buses.filter((b) => b.active).length} active buses. Each bus has its own portal, QR code and incharge.</p>
        {!ro && <a className="btn" href="#import"><Icon name="upload" className="size-4" />Import Excel</a>}
        {!ro && <button className="btn btn-primary" onClick={() => setEdit({})}><Icon name="plus" className="size-4" />Add bus</button>}
      </div>
      {data.buses.length ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.buses.map((b) => (
            <div key={b.id} className={`card flex flex-col gap-3 p-5 ${b.active ? '' : 'opacity-60'}`}>
              <div className="flex items-start gap-3">
                <span className="flex h-11 min-w-11 items-center justify-center rounded-xl bg-brand px-2 text-sm font-extrabold text-white">{b.number}</span>
                <div className="min-w-0 grow">
                  <div className="truncate font-bold text-navy">{b.name}</div>
                  <div className="text-xs text-muted">{b.route || 'No route description'}</div>
                </div>
                {b.live ? <span className="pill pill-ok">Running</span> : !b.active ? <span className="pill pill-muted">Inactive</span> : null}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                <span className="flex items-center gap-1"><Icon name="users" className="size-3.5" />{b.students} students</span>
                <span className="flex items-center gap-1"><Icon name="user" className="size-3.5" />{b.incharges.map((u) => u.username).join(', ') || 'No incharge'}</span>
              </div>
              <div>
                <div className="mb-1.5 text-xs font-bold uppercase tracking-wide text-muted">Routes / pickup points</div>
                <div className="flex flex-wrap gap-1.5">
                  {b.stops.length ? b.stops.map((s) => (
                    <span key={s.id} className="pill pill-muted max-w-full">
                      <span className="truncate" title={s.name}>{s.name}</span>
                      {!ro && <button className="text-muted hover:text-uured" onClick={() => removeStop(s)} aria-label={`Remove ${s.name}`}><Icon name="x" className="size-3" /></button>}
                    </span>
                  )) : <span className="text-xs text-muted">None yet</span>}
                </div>
                {!ro && <AddStop onAdd={(name) => addStop(b, name)} />}
              </div>
              <div className="mt-auto flex flex-wrap gap-2 border-t border-line pt-3">
                <Link className="btn btn-sm" to={`/bus/${encodeURIComponent(b.number)}`}><Icon name="qr" className="size-4" />Portal</Link>
                {!ro && <button className="btn btn-sm" onClick={() => setEdit(b)}><Icon name="edit" className="size-4" />Edit</button>}
                {!ro && <button className="btn btn-sm btn-ghost hover:text-uured" onClick={() => remove(b)}><Icon name="trash" className="size-4" />Remove</button>}
              </div>
            </div>
          ))}
        </div>
      ) : <div className="card"><Empty icon="bus">No buses yet. Import your Excel workbook (Import Excel) or add a bus.</Empty></div>}
      {edit && <BusForm bus={edit.id ? edit : null} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

function AddStop({ onAdd }) {
  const [v, setV] = useState('');
  return (
    <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (v.trim()) { onAdd(v.trim()); setV(''); } }}>
      <input className="input py-1.5 text-sm" placeholder="Add a pickup point…" value={v} onChange={(e) => setV(e.target.value)} maxLength={80} />
      <button className="btn btn-sm" type="submit" aria-label="Add"><Icon name="plus" className="size-4" /></button>
    </form>
  );
}

function BusForm({ bus, onClose, onSaved }) {
  const toast = useToast();
  const [error, action, pending] = useActionState(async (_p, f) => {
    const body = { number: String(f.get('number')).trim(), name: String(f.get('name')).trim(), route: f.get('route'), active: f.get('active') === 'on' };
    if (!body.name) body.name = `Bus ${body.number}`;
    try {
      if (bus) await api.put(`/api/admin/buses/${bus.id}`, body); else await api.post('/api/admin/buses', body);
      toast('Bus saved', 'success');
      onSaved();
      return null;
    } catch (e) { return e.message; }
  }, null);
  return (
    <Modal title={bus ? `Edit bus ${bus.number}` : 'Add bus'} onClose={onClose}>
      <form action={action} className="flex flex-col gap-4">
        <Field label="Bus number" help="The portal address follows it: /bus/UU-10"><input className="input" name="number" defaultValue={bus?.number} placeholder="UU-10" required maxLength={20} /></Field>
        <Field label="Name"><input className="input" name="name" defaultValue={bus?.name} placeholder="Bus UU-10" maxLength={60} /></Field>
        <Field label="Route"><input className="input" name="route" defaultValue={bus?.route} placeholder="Jhunsi → Civil Lines → Campus" maxLength={200} /></Field>
        <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" name="active" defaultChecked={bus ? !!bus.active : true} className="size-4 accent-brand" />Active</label>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>Cancel</button><SubmitButton pending={pending}>Save bus</SubmitButton></div>
      </form>
    </Modal>
  );
}
