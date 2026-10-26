import { BrandHeader, Footer } from '../components/Brand.jsx';

export function NotFound() {
  return (
    <div className="min-h-dvh">
      <BrandHeader />
      <main className="mx-auto my-10 w-[min(560px,94%)]">
        <div className="card p-8 text-center">
          <h2 className="text-2xl font-bold text-navy">Page not found</h2>
          <p className="mt-3 text-muted">That link doesn't exist. If you scanned a QR code, scan the one inside your bus again.</p>
          <a className="btn btn-primary mt-6" href="/">Go to the start page</a>
        </div>
      </main>
      <Footer />
    </div>
  );
}
