import { lazy, Suspense, useState } from 'react';
import { useLocation, Link } from '../../lib/router.jsx';
import { useSession } from '../../lib/session.jsx';
import { Icon } from '../../components/Icon.jsx';
import { Loading } from '../../components/ui.jsx';
import { PasswordChange } from '../../components/PasswordChange.jsx';
import { initials } from '../../lib/format.js';
import Dashboard from './Dashboard.jsx';

const Students = lazy(() => import('./Students.jsx'));
const Buses = lazy(() => import('./Buses.jsx'));
const ImportData = lazy(() => import('./ImportData.jsx'));
const Staff = lazy(() => import('./Staff.jsx'));
const Trips = lazy(() => import('./Trips.jsx'));
const Flags = lazy(() => import('./Flags.jsx'));
const Audit = lazy(() => import('./Audit.jsx'));
const Settings = lazy(() => import('./Settings.jsx'));

const PAGES = [
  { key: 'dashboard', title: 'Dashboard', icon: 'dashboard', C: Dashboard },
  { key: 'students', title: 'Students', icon: 'users', C: Students },
  { key: 'buses', title: 'Buses & routes', icon: 'bus', C: Buses },
  { key: 'import', title: 'Import Excel', icon: 'upload', C: ImportData, superOnly: true },
  { key: 'staff', title: 'Staff', icon: 'staff', C: Staff, superOnly: true },
  { key: 'trips', title: 'Trips', icon: 'trips', C: Trips },
  { key: 'flags', title: 'Flags', icon: 'flag', C: Flags },
  { key: 'audit', title: 'Audit log', icon: 'audit', C: Audit, superOnly: true },
  { key: 'settings', title: 'Settings', icon: 'settings', C: Settings, superOnly: true },
];

/** Transport console: super admin (everything) and operations admin (read-only). Pages live in the URL hash. */
export default function AdminApp() {
  const { user, logout, refresh } = useSession();
  const { hash } = useLocation();
  const [menu, setMenu] = useState(false);
  const [pw, setPw] = useState(false);
  const pages = PAGES.filter((p) => !p.superOnly || user.role === 'admin');
  const page = pages.find((p) => p.key === hash.split('?')[0]) || pages[0];
  const Page = page.C;

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[260px_1fr]">
      {menu && <div className="fixed inset-0 z-30 bg-navy/40 lg:hidden" onClick={() => setMenu(false)} />}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-[260px] flex-col border-r border-line bg-white transition-transform lg:sticky lg:top-0 lg:h-dvh lg:translate-x-0 ${menu ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex items-center gap-3 bg-[linear-gradient(110deg,var(--color-navy),var(--color-brand))] px-4 py-4 text-white">
          <img src="/img/uu-crest.png" alt="" width="44" height="44" className="size-11 rounded-lg bg-white p-1" />
          <div><div className="font-bold leading-tight">United University</div><div className="text-xs opacity-90">Transport console</div></div>
        </div>
        <nav className="flex grow flex-col gap-0.5 overflow-y-auto p-3">
          {pages.map((p) => (
            <a key={p.key} href={`#${p.key}`} onClick={() => setMenu(false)}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold transition ${p.key === page.key ? 'bg-brand text-white' : 'text-ink hover:bg-brand-soft hover:text-brand'}`}>
              <Icon name={p.icon} className="size-[18px]" />{p.title}
            </a>
          ))}
          <Link to="/incharge" className="mt-2 flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold text-ink hover:bg-brand-soft hover:text-brand">
            <Icon name="qr" className="size-[18px]" />Bus portals
          </Link>
        </nav>
        <div className="border-t border-line p-3">
          <div className="flex items-center gap-3 px-1">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-sm font-bold text-brand">{initials(user.name)}</span>
            <div className="min-w-0 grow"><div className="truncate text-sm font-semibold">{user.name}</div><div className="truncate text-xs text-muted">{user.roleLabel}</div></div>
          </div>
          <div className="mt-2 flex gap-2">
            {user.canChangePassword && <button className="btn btn-sm grow" onClick={() => setPw(true)}><Icon name="key" className="size-4" />Password</button>}
            <button className="btn btn-sm grow" onClick={logout}><Icon name="logout" className="size-4" />Sign out</button>
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-white/90 px-4 py-3 backdrop-blur sm:px-6">
          <button className="btn btn-ghost btn-icon lg:hidden" onClick={() => setMenu(true)} aria-label="Menu"><Icon name="menu" /></button>
          <h1 className="grow truncate text-xl font-bold text-navy">{page.title}</h1>
          {user.readOnly && <span className="pill pill-muted">Read-only</span>}
        </header>
        <main className="mx-auto max-w-7xl p-4 sm:p-6">
          {/* nothing loads until a temporary password is replaced (the API refuses it anyway) */}
          {!user.mustChangePassword && <Suspense fallback={<Loading />}><Page key={page.key} /></Suspense>}
        </main>
      </div>

      {(pw || user.mustChangePassword) && (
        <PasswordChange forced={user.mustChangePassword} onClose={() => setPw(false)} onDone={() => { setPw(false); refresh(); }} />
      )}
    </div>
  );
}
