import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

/*
 * Live events with the transport the server chose (api.liveMode from /api/auth/me):
 *  - 'sse'  one long Server-Sent Events connection (single server, instant)
 *  - 'poll' ask /api/events/poll every few seconds (serverless; slower while the tab is hidden)
 * Handlers are read through a ref, so callers can pass a fresh object every render.
 * Returns true while connected.
 */
export function useLive(handlers, enabled = true) {
  const ref = useRef(handlers);
  ref.current = handlers;
  const [ok, setOk] = useState(false);

  useEffect(() => {
    if (!enabled) return undefined;
    const dispatch = (type, data) => {
      const fn = ref.current[type];
      if (fn) { try { fn(data); } catch (e) { console.error('live handler failed', type, e); } }
    };
    return api.liveMode === 'poll' ? poll(dispatch, setOk) : sse(dispatch, setOk);
  }, [enabled]);

  return ok;
}

function poll(dispatch, setOk) {
  let cursor = 0;
  let stopped = false;
  let timer = null;
  let inflight = false;
  let failures = 0;
  const VISIBLE = Math.max(1500, Number(api.pollMs) || 2500);
  const HIDDEN = Math.max(15000, VISIBLE * 4);
  const schedule = (ms) => { clearTimeout(timer); if (!stopped) timer = setTimeout(tick, ms); };
  async function tick() {
    if (stopped || inflight) return;
    inflight = true;
    try {
      const r = await api.get(`/api/events/poll?after=${cursor}`);
      for (const ev of r.events) dispatch(ev.type, ev.data);
      cursor = r.cursor;
      failures = 0;
      setOk(true);
    } catch (e) {
      failures++;
      setOk(false);
      if (e.status === 401) { stopped = true; return; }
    } finally {
      inflight = false;
    }
    schedule(failures ? Math.min(VISIBLE * 2 ** failures, 20000) : document.hidden ? HIDDEN : VISIBLE);
  }
  const onVisible = () => { if (!document.hidden && !inflight) schedule(0); };
  document.addEventListener('visibilitychange', onVisible);
  tick();
  return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
}

const SSE_TYPES = ['checkin', 'trip', 'duplicate'];
function sse(dispatch, setOk) {
  let es = null;
  let stopped = false;
  let retry = 1000;
  let timer = null;
  const connect = () => {
    if (stopped) return;
    es = new EventSource('/api/events');
    es.addEventListener('hello', () => { retry = 1000; setOk(true); });
    for (const type of SSE_TYPES) {
      es.addEventListener(type, (e) => { try { dispatch(type, JSON.parse(e.data)); } catch (err) { console.error(err); } });
    }
    es.onerror = () => {
      setOk(false);
      es.close();
      timer = setTimeout(connect, retry);
      retry = Math.min(retry * 1.6, 15000);
    };
  };
  connect();
  return () => { stopped = true; clearTimeout(timer); es?.close(); };
}

/** Run fn at most once per `ms` (trailing call kept): for refetching after bursts of live events. */
export function useThrottled(fn, ms = 800) {
  const ref = useRef(fn);
  ref.current = fn;
  const state = useRef({ timer: null, last: 0 });
  useEffect(() => () => clearTimeout(state.current.timer), []);
  return () => {
    const s = state.current;
    const wait = Math.max(0, s.last + ms - Date.now());
    clearTimeout(s.timer);
    s.timer = setTimeout(() => { s.last = Date.now(); ref.current(); }, wait);
  };
}
