import type { ReactNode } from 'react';

export interface SheetHead {
  left: string;
  right: string;
}

/** One printed section; starts a new page in print (see report.css). */
export function Sheet({ label, head, children }: { label: string; head?: SheetHead; children: ReactNode }) {
  return (
    <section className="rp-sheet" aria-label={label}>
      {head && (
        <header className="rp-screen-head" aria-hidden="true">
          <span>{head.left}</span>
          <span>{head.right}</span>
        </header>
      )}
      {children}
    </section>
  );
}
