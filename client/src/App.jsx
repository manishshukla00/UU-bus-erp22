import { lazy, Suspense, useEffect } from 'react';
import { useLocation, navigate } from './lib/router.jsx';
import { SessionProvider, useSession } from './lib/session.jsx';
import { ToastProvider, ConfirmHost, Loading } from './components/ui.jsx';
import { NotFound } from './pages/NotFound.jsx';

// Each area is its own bundle: a student's phone downloads only the check-in page.
const Checkin = lazy(() => import('./pages/Checkin.jsx'));
const Login = lazy(() => import('./pages/Login.jsx'));
const AdminApp = lazy(() => import('./pages/admin/AdminApp.jsx'));
const Portal = lazy(() => import('./pages/portal/Portal.jsx'));

export function App() {
  const { path } = useLocation();
  // students never sign in: the check-in page skips the staff session entirely
  if (path === '/checkin' || path.startsWith('/checkin/')) {
    return (
      <ToastProvider>
        <Suspense fallback={<Loading />}><Checkin /></Suspense>
      </ToastProvider>
    );
  }
  return (
    <ToastProvider>
      <SessionProvider>
        <Suspense fallback={<Loading />}><StaffRoutes path={path} /></Suspense>
        <ConfirmHost />
      </SessionProvider>
    </ToastProvider>
  );
}

const STAFF_PAGES = { admin: ['admin', 'operator'], incharge: ['incharge', 'admin', 'operator'], bus: ['incharge', 'admin', 'operator'] };

function StaffRoutes({ path }) {
  const { loading, user } = useSession();
  const section = path.split('/')[1] || '';
  const known = section === '' || section === 'login' || section in STAFF_PAGES;
  const allowed = STAFF_PAGES[section];

  useEffect(() => {
    if (loading || !known) return;
    if (section === 'login') { if (user) navigate(user.home, { replace: true }); return; }
    if (!user) { navigate(section ? `/login?next=${encodeURIComponent(path)}` : '/login', { replace: true }); return; }
    if (section === '' || !allowed.includes(user.role)) navigate(user.home, { replace: true });
    // a bus admin with a bus goes straight to their own portal
    else if (section === 'incharge' && user.role === 'incharge' && user.bus_number) navigate(user.home, { replace: true });
  }, [loading, user, section, path, known, allowed]);

  if (!known) return <NotFound />;
  if (section === 'login') return user ? <Loading /> : <Login />;
  if (loading || !user || section === '' || !allowed.includes(user.role)) return <Loading />;
  if (section === 'admin') return <AdminApp />;
  return <Portal />;
}
