import { useActionState, useState } from 'react';
import { api } from '../../lib/api.js';
import { useFetch } from '../../lib/useFetch.js';
import { useSession } from '../../lib/session.jsx';
import { fmtRel } from '../../lib/format.js';
import { Icon } from '../../components/Icon.jsx';
import { Empty, ErrorText, Field, Loading, Modal, PasswordInput, SubmitButton, confirm, copyText, useToast } from '../../components/ui.jsx';

const ROLES = [['incharge', 'Bus incharge'], ['operator', 'Operations admin (read-only)'], ['admin', 'Super admin']];
const roleLabel = (r) => (ROLES.find(([k]) => k === r) || [r, r])[1];

export default function Staff() {
  const { user } = useSession();
  const toast = useToast();
  const { data, loading, error, reload } = useFetch('/api/admin/users');
  const buses = useFetch('/api/admin/buses');
  const [edit, setEdit] = useState(null);
  const [setPw, setSetPw] = useState(null);
  const [shown, setShown] = useState(null);

  const view = async (u) => {
    try { setShown({ ...(await api.get(`/api/admin/users/${u.id}/password`)), name: u.name }); }
    catch (e) { toast(e.message, 'error', 6000); }
  };
  const remove = async (u) => {
    if (!(await confirm({ title: `Remove ${u.name}?`, message: 'Accounts with trip history are deactivated instead of deleted.', okText: 'Remove', danger: true }))) return;
    try { const r = await api.del(`/api/admin/users/${u.id}`); toast(r.deactivated ? `${u.name} deactivated` : `${u.name} removed`, 'success'); reload(); } catch (e) { toast(e.message, 'error'); }
  };

  if (loading && !data) return <Loading />;
  if (error) return <div className="card"><Empty icon="alert">{error.message}</Empty></div>;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="grow text-sm text-muted">Bus incharges and operations admins cannot change their own password; you set it here (key) and can look it up later (eye).</p>
        <button className="btn btn-primary" onClick={() => setEdit({})}><Icon name="plus" className="size-4" />Add staff</button>
      </div>
      <div className="card">
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Name</th><th>Login ID</th><th>Role</th><th>Bus</th><th>Status</th><th>Last seen</th><th></th></tr></thead>
            <tbody>
              {data.items.map((u) => (
                <tr key={u.id} className={u.active ? '' : 'opacity-55'}>
                  <td className="font-semibold">{u.name}</td>
                  <td className="font-mono text-xs">{u.username}</td>
                  <td className="text-xs">{roleLabel(u.role)}</td>
                  <td className="whitespace-nowrap font-semibold">{u.bus_number || "—"}</td>
                  <td className="whitespace-nowrap">
                    {u.active ? <span className="pill pill-ok">Active</span> : <span className="pill pill-muted">Inactive</span>}
                    {u.locked_until > Date.now() && <span className="pill pill-red ml-1">Locked</span>}
                    {u.role === 'admin' && !!u.must_change_password && <span className="pill pill-warn ml-1">New password due</span>}
                  </td>
                  <td className="whitespace-nowrap text-xs text-muted">{u.last_seen ? fmtRel(u.last_seen) : 'Never'}</td>
                  <td className="whitespace-nowrap text-right">
                    {u.role !== 'admin' && <button className="btn btn-ghost btn-icon" title={u.password_viewable ? 'View password' : 'Not viewable yet: set a new one first'} onClick={() => view(u)}><Icon name="eye" className="size-4" /></button>}
                    <button className="btn btn-ghost btn-icon" title="Set password" disabled={u.id === user.id} onClick={() => setSetPw(u)}><Icon name="key" className="size-4" /></button>
                    <button className="btn btn-ghost btn-icon" title="Edit" onClick={() => setEdit(u)}><Icon name="edit" className="size-4" /></button>
                    <button className="btn btn-ghost btn-icon hover:text-uured" title="Remove" disabled={u.id === user.id} onClick={() => remove(u)}><Icon name="trash" className="size-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {edit && <UserForm u={edit.id ? edit : null} buses={buses.data?.buses || []} onClose={() => setEdit(null)} onSaved={(pw) => { setEdit(null); reload(); if (pw) setShown(pw); }} />}
      {setPw && <SetPassword u={setPw} onClose={() => setSetPw(null)} onSaved={(pw) => { setSetPw(null); reload(); if (pw) setShown(pw); }} />}
      {shown && (
        <Modal title={`Password for ${shown.name}`} onClose={() => setShown(null)} footer={<button className="btn btn-primary" data-autofocus onClick={() => setShown(null)}>Done</button>}>
          <div className="flex flex-col gap-3 text-sm">
            <div><div className="label">Login ID</div><div className="font-mono font-bold">{shown.username}</div></div>
            <div><div className="label">Password</div>
              <div className="flex items-center gap-2"><code className="rounded-lg bg-page px-3 py-2 text-base font-bold">{shown.password}</code>
                <button className="btn btn-icon" onClick={() => copyText(shown.password, toast)} aria-label="Copy password"><Icon name="copy" className="size-4" /></button></div>
            </div>
            <p className="text-xs text-muted">Share it privately. Every view is recorded in the audit log.</p>
          </div>
        </Modal>
      )}
    </div>
  );
}

function UserForm({ u, buses, onClose, onSaved }) {
  const toast = useToast();
  const [role, setRole] = useState(u?.role || 'incharge');
  const [error, action, pending] = useActionState(async (_p, f) => {
    const body = { name: f.get('name'), username: String(f.get('username')).trim(), role, bus_id: f.get('bus_id') || null, active: f.get('active') === 'on' };
    if (!u && f.get('password')) body.password = f.get('password');
    try {
      if (u) { await api.put(`/api/admin/users/${u.id}`, body); toast('Saved', 'success'); onSaved(null); }
      else {
        const r = await api.post('/api/admin/users', body);
        toast('Account created', 'success');
        onSaved(body.password ? null : { username: body.username, password: r.password, name: body.name });
      }
      return null;
    } catch (e) { return e.message; }
  }, null);
  return (
    <Modal title={u ? `Edit ${u.name}` : 'Add staff'} onClose={onClose}>
      <form action={action} className="grid grid-cols-1 gap-4 sm:grid-cols-2" autoComplete="off">
        <Field label="Full name" className="sm:col-span-2"><input className="input" name="name" defaultValue={u?.name} required maxLength={80} /></Field>
        <Field label="Login ID" help="Letters, numbers, dot, dash, underscore."><input className="input font-mono" name="username" defaultValue={u?.username} required minLength={3} maxLength={32} autoCapitalize="off" placeholder="IC-UU10" /></Field>
        <Field label="Role">
          <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </Field>
        {role === 'incharge' && (
          <Field label="Bus" className="sm:col-span-2">
            <select className="input" name="bus_id" defaultValue={u?.bus_id ?? ''}><option value="">No bus (can open every bus)</option>{buses.map((b) => <option key={b.id} value={b.id}>{b.number}</option>)}</select>
          </Field>
        )}
        {!u && <Field label="Password" help="Leave empty to generate one." className="sm:col-span-2"><PasswordInput name="password" /></Field>}
        <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" name="active" defaultChecked={u ? !!u.active : true} className="size-4 accent-brand" />Active</label>
        <div className="sm:col-span-2"><ErrorText>{error}</ErrorText></div>
        <div className="flex justify-end gap-2 sm:col-span-2"><button type="button" className="btn" onClick={onClose}>Cancel</button><SubmitButton pending={pending}>Save</SubmitButton></div>
      </form>
    </Modal>
  );
}

function SetPassword({ u, onClose, onSaved }) {
  const toast = useToast();
  const [error, action, pending] = useActionState(async (_p, f) => {
    try {
      const r = await api.post(`/api/admin/users/${u.id}/password`, { password: String(f.get('password') || '').trim() });
      toast(`Password for ${u.name} updated`, 'success');
      onSaved(r.generated ? { username: u.username, password: r.password, name: u.name } : null);
      return null;
    } catch (e) { return e.message; }
  }, null);
  return (
    <Modal title={`Set password for ${u.name}`} onClose={onClose}>
      <form action={action} method="post" className="flex flex-col gap-4" autoComplete="off">
        <p className="text-sm text-muted">{u.role === 'admin' ? 'They will choose their own password at next sign-in.' : 'This is the password they will use.'} They are signed out on every device.</p>
        <Field label="New password" help="At least 10 characters with letters and numbers. Leave empty to generate one."><PasswordInput name="password" placeholder="Leave empty to generate" /></Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={onClose}>Cancel</button><SubmitButton pending={pending}>Set password</SubmitButton></div>
      </form>
    </Modal>
  );
}
