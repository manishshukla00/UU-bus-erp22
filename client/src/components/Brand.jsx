/* University header band (navy → blue → red), as on the Apps Script page. */
export function BrandHeader({ subtitle = 'University Bus Verification System', right = null, compact = false }) {
  return (
    <header className={`bg-[linear-gradient(110deg,var(--color-navy),var(--color-brand),var(--color-uured))] text-white ${compact ? 'px-4 py-3 sm:px-6' : 'px-[5%] py-5'}`}>
      <div className="mx-auto flex max-w-6xl items-center gap-4">
        <img src="/img/uu-crest.png" alt="United University" width="64" height="64"
          className={`shrink-0 rounded-[10px] bg-white object-contain p-[5px] ${compact ? 'size-11' : 'size-[50px] sm:size-16'}`} />
        <div className="min-w-0 grow">
          <h1 className={`m-0 font-bold leading-tight ${compact ? 'text-lg' : 'text-[21px] sm:text-[25px]'}`}>United University</h1>
          <p className={`mt-1 truncate opacity-95 ${compact ? 'text-xs' : 'text-sm sm:text-base'}`}>{subtitle}</p>
        </div>
        {right}
      </div>
    </header>
  );
}

export function Footer() {
  return <footer className="px-4 py-6 text-center text-xs text-muted">Developed for United University, Prayagraj</footer>;
}
