import { createContext, use, useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { navigate } from './router.jsx';

/*
 * The signed-in staff member (or null). Loaded once from /api/auth/me; login and logout update it.
 * Students never sign in, so the check-in page does not use this.
 */
const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, error: null });

  const apply = useCallback((me) => {
    api.csrf = me.csrf;
    api.liveMode = me.live || 'sse';
    api.pollMs = me.pollMs || 2500;
    setState({ loading: false, user: me.user, error: null });
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply(await api.get('/api/auth/me'));
    } catch (e) {
      if (e.status === 401) setState({ loading: false, user: null, error: null });
      else setState({ loading: false, user: null, error: e });
    }
  }, [apply]);

  useEffect(() => {
    api.onUnauthenticated = () => {
      setState({ loading: false, user: null, error: null });
      if (!location.pathname.startsWith('/login')) navigate(`/login?next=${encodeURIComponent(location.pathname)}`, { replace: true });
    };
    refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try { await api.post('/api/auth/logout'); } catch { /* signed out anyway */ }
    api.csrf = null;
    setState({ loading: false, user: null, error: null });
    navigate('/login', { replace: true });
  }, []);

  const value = { ...state, apply, refresh, logout, setUser: (user) => setState((s) => ({ ...s, user })) };
  return <SessionContext value={value}>{children}</SessionContext>;
}

export const useSession = () => use(SessionContext);
