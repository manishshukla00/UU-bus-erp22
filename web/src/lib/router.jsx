import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

/*
 * A tiny router: the app has a handful of top-level pages (/login, /admin, /incharge, /bus/:n,
 * /checkin/:bus), so the URL is read straight from history instead of pulling in a router library.
 */
const listeners = new Set();
const notify = () => listeners.forEach((l) => l());
window.addEventListener('popstate', notify);
window.addEventListener('hashchange', notify);

const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
const snapshot = () => location.pathname + location.search + location.hash;

/** Re-renders on navigation; returns { path, search, hash }. */
export function useLocation() {
  useSyncExternalStore(subscribe, snapshot);
  return { path: location.pathname, search: new URLSearchParams(location.search), hash: location.hash.slice(1) };
}

export function navigate(to, { replace = false } = {}) {
  if (to === snapshot()) return;
  const go = (sync) => {
    history[replace ? 'replaceState' : 'pushState'](null, '', to);
    if (sync) flushSync(notify); else notify();
    window.scrollTo(0, 0);
  };
  // a short native cross-fade between pages where the browser supports it (no JavaScript animation);
  // redirects (replace) switch at once
  if (!replace && document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(() => go(true));
  else go(false);
}

/** <a> that navigates without a page load (plain clicks only; ctrl/middle-click open a new tab). */
export function Link({ to, onClick, ...props }) {
  return (
    <a
      href={to}
      {...props}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}
