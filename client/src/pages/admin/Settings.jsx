import { useActionState, useState } from 'react';
import { api } from '../../lib/api.js';
import { useFetch } from '../../lib/useFetch.js';
import { Empty, ErrorText, Field, Loading, SubmitButton, useToast } from '../../components/ui.jsx';

export default function Settings() {
  const toast = useToast();
  const { data, loading, error, reload } = useFetch('/api/admin/settings');
  const [savingMode, setSavingMode] = useState(false);
  const [urlError, saveUrl, savingUrl] = useActionState(async (_p, f) => {
    try { await api.put('/api/admin/settings', { base_url: String(f.get('base_url') || '').trim() }); toast('Saved', 'success'); reload(); return null; } catch (e) { return e.message; }
  }, null);

  const setHours = async (hours) => {
    setSavingMode(true);
    try { await api.put('/api/admin/settings', { qr_trip_hours: Number(hours) }); toast('QR hours updated', 'success'); reload(); } catch (e) { toast(e.message, 'error'); } finally { setSavingMode(false); }
  };

  const setMode = async (qr_mode) => {
    setSavingMode(true);
    try { await api.put('/api/admin/settings', { qr_mode }); toast('QR validity updated', 'success'); reload(); } catch (e) { toast(e.message, 'error'); } finally { setSavingMode(false); }
  };

  if (loading && !data) return <Loading />;
  if (error) return <div className="card"><Empty icon="alert">{error.message}</Empty></div>;
  const modes = [
    ['trip', `Per trip, ${data.qrTripHours} hours`, `Each trip gets its own QR, valid for ${data.qrTripHours} hours from the start of the trip. A photo of it is useless on any other trip. The incharge can press "New QR code" for another ${data.qrTripHours} hours.`],
    ['day', 'Whole day', 'One QR per bus per day (India time). Can be printed and stuck in the bus. The incharge can cancel it with "New QR code" if a photo of it is shared.'],
    ['rotating', `Rotating every ${data.qrRotateSec} s`, 'Strongest protection: only the live screen works, screenshots expire within seconds. The incharge must keep the portal open.'],
  ];
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <section className="card p-6">
        <h2 className="text-lg font-bold text-navy">QR validity</h2>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {modes.map(([k, title, text]) => (
            <button key={k} disabled={savingMode} onClick={() => data.qrMode !== k && setMode(k)}
              className={`rounded-2xl border-2 p-4 text-left transition-all duration-200 hover:-translate-y-0.5 ${data.qrMode === k ? 'border-brand bg-brand-soft shadow-[var(--shadow-lift)]' : 'border-line hover:border-brand/50'}`}>
              <div className="flex items-center justify-between font-bold text-navy">{title}{data.qrMode === k && <span className="pill">Active</span>}</div>
              <p className="mt-2 text-xs text-muted">{text}</p>
            </button>
          ))}
        </div>
        {data.qrMode === 'trip' && (
          <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); setHours(new FormData(e.currentTarget).get('hours')); }}>
            <Field label="Hours a trip's QR stays valid" help="From 0.5 to 12 hours.">
              <input className="input w-32" name="hours" type="number" min="0.5" max="12" step="0.5" defaultValue={data.qrTripHours} key={data.qrTripHours} />
            </Field>
            <button className="btn mb-[22px]" type="submit" disabled={savingMode}>Save hours</button>
          </form>
        )}
      </section>
      <section className="card p-6">
        <h2 className="text-lg font-bold text-navy">Public address</h2>
        <p className="mt-2 text-sm text-muted">The address QR codes point to. Leave empty to use this site's own address. Currently: <b className="font-mono">{data.effectiveBaseUrl}</b></p>
        <form action={saveUrl} className="mt-4 flex flex-col gap-3">
          <Field label="Public base URL"><input className="input font-mono" name="base_url" defaultValue={data.base_url} placeholder="https://bus.uniteduniversity.edu.in" /></Field>
          <ErrorText>{urlError}</ErrorText>
          <div><SubmitButton pending={savingUrl}>Save</SubmitButton></div>
        </form>
      </section>
      <section className="card p-6 text-sm">
        <h2 className="text-lg font-bold text-navy">System</h2>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          <dt className="text-muted">Database</dt><dd className="font-semibold">{data.database}</dd>
          <dt className="text-muted">Live updates</dt><dd className="font-semibold">{data.liveMode === 'sse' ? 'Instant push' : 'Polling'}</dd>
          <dt className="text-muted">Check-in window</dt><dd className="font-semibold">{data.checkinMinutes} minutes after scanning</dd>
          <dt className="text-muted">Phones per student</dt><dd className="font-semibold">{data.maxDevicesPerStudent} in 30 days</dd>
        </dl>
      </section>
    </div>
  );
}
