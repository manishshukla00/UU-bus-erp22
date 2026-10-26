import { useActionState, useEffect } from 'react';
import { api } from '../lib/api.js';
import { navigate, useLocation } from '../lib/router.jsx';
import { useSession } from '../lib/session.jsx';
import { BrandHeader, Footer } from '../components/Brand.jsx';
import { Field, PasswordInput, ErrorText, SubmitButton } from '../components/ui.jsx';
import { Icon } from '../components/Icon.jsx';

const SAFE_NEXT = /^\/(admin|incharge|bus\/[A-Za-z0-9%._-]+)$/;

export default function Login() {
  const { apply } = useSession();
  // fetch the console and portal code while the user types, so the page after sign-in opens at once
  useEffect(() => {
    const t = setTimeout(() => { import('./admin/AdminApp.jsx'); import('./admin/Dashboard.jsx'); import('./portal/Portal.jsx'); }, 400);
    return () => clearTimeout(t);
  }, []);
  const { search } = useLocation();
  // React resets the form after the action; the typed Login ID comes back as its default value
  const [state, action, pending] = useActionState(async (_prev, form) => {
    const username = String(form.get('username')).trim();
    try {
      const r = await api.post('/api/auth/login', { username, password: form.get('password') });
      apply({ user: r.user, csrf: r.csrf, live: r.live, pollMs: r.pollMs });
      const next = search.get('next');
      navigate(next && SAFE_NEXT.test(next) ? next : r.user.home, { replace: true });
      return { error: null, username };
    } catch (e) {
      return { error: e.message, username };
    }
  }, { error: null, username: '' });

  return (
    <div className="min-h-dvh">
      <BrandHeader />
      <main className="stagger mx-auto my-6 grid w-[min(1100px,94%)] grid-cols-1 gap-[18px] md:grid-cols-2">
        <section className="card p-[22px]">
          <h2 className="text-xl font-bold text-navy">Admin / Incharge Login</h2>
          <p className="mt-2 text-muted">Enter your assigned Login ID and password.</p>
          <form action={action} method="post" className="mt-4 flex flex-col gap-4" autoComplete="on">
            <Field label="Login ID">
              <input className="input" name="username" defaultValue={state.username} autoComplete="username" autoCapitalize="off" spellCheck="false" required
                autoFocus={matchMedia('(min-width: 861px)').matches} />
            </Field>
            <Field label="Password"><PasswordInput name="password" autoComplete="current-password" required /></Field>
            <ErrorText>{state.error}</ErrorText>
            <SubmitButton pending={pending} className="btn btn-primary w-full py-3">Sign in</SubmitButton>
          </form>
        </section>

        <section className="card p-[22px]">
          <h2 className="text-xl font-bold text-navy">Bus Verification</h2>
          <div className="my-4 flex items-center gap-4 rounded-xl border border-line bg-brand-soft p-3.5">
            <img src="/img/campus-buses.jpg" alt="University buses" width="110" height="72" className="h-[60px] w-20 shrink-0 rounded-md object-cover sm:h-[72px] sm:w-[110px]" />
            <div>
              <strong className="text-navy">United University Transport</strong>
              <p className="text-sm text-muted">Daily student verification</p>
            </div>
          </div>
          <ul className="flex flex-col gap-3 text-sm">
            <li className="flex gap-3"><Icon name="qr" className="size-5 shrink-0 text-brand" />Each bus incharge opens their bus portal and shows the bus QR code.</li>
            <li className="flex gap-3"><Icon name="scan" className="size-5 shrink-0 text-brand" />Students scan it with their own phone and enter their UUID or enrollment number. No login, no app.</li>
            <li className="flex gap-3"><Icon name="checkCircle" className="size-5 shrink-0 text-ok" />The incharge and the admin see every verified student live, with today's count.</li>
          </ul>
          <p className="mt-4 text-xs text-muted">Admin access is required to manage buses, students and incharge accounts.</p>
        </section>
      </main>
      <Footer />
    </div>
  );
}
