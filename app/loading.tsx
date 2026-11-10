import { AppHeader } from './app-header';

export default function Loading() {
  return (
    <main id="main-content" className="board-page" aria-busy="true">
      <AppHeader current="/" />
      <section className="board-intro" aria-label="Loading job board">
        <div>
          {/* Not a heading: this fallback is first in the streamed HTML, and a crawler that runs
              no script would take it for the page's h1. */}
          <p className="board-title">Loading jobs…</p>
          <span className="skeleton-line mt-2 w-44" aria-hidden="true" />
        </div>
      </section>
      <div className="filter-form" aria-hidden="true">
        {[70, 180, 150, 130].map((width) => (
          <span key={width} className="skeleton-line h-[30px] rounded-[var(--r)]" style={{ width }} />
        ))}
      </div>
      <div className="sheet-wrap min-h-0 flex-1 overflow-hidden" aria-hidden="true">
        <div className="loading-row loading-head label"><span>Seen</span><span>Role</span><span>Pay</span><span>Company</span></div>
        {Array.from({ length: 14 }, (_, index) => (
          <div className="loading-row" key={index}>
            <span className="skeleton-line w-8" />
            <span className="skeleton-line" style={{ width: `${52 + (index % 4) * 11}%` }} />
            <span className="skeleton-line w-16" />
            <span className="skeleton-line w-24" />
          </div>
        ))}
      </div>
    </main>
  );
}
