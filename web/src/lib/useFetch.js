import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

/**
 * GET a URL and keep the result; refetches when the URL changes. reload() refetches quietly (the old
 * data stays on screen meanwhile, so live refreshes never flash a spinner). Pass null to skip.
 */
export function useFetch(url) {
  const [state, setState] = useState({ data: null, error: null, loading: !!url });
  const seq = useRef(0);
  const load = useCallback(async (quiet) => {
    if (!url) return;
    const mine = ++seq.current;
    if (!quiet) setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await api.get(url);
      if (mine === seq.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (mine === seq.current) setState((s) => ({ ...s, error, loading: false }));
    }
  }, [url]);
  useEffect(() => { load(false); }, [load]);
  const reload = useCallback(() => load(true), [load]);
  return { ...state, reload, setData: (fn) => setState((s) => ({ ...s, data: typeof fn === 'function' ? fn(s.data) : fn })) };
}
