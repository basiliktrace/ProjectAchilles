import { Children, type CSSProperties, type ReactNode } from 'react';

/**
 * KPI tile grid. On large screens the column count equals the number of
 * tiles, so an integration tile (e.g. CrowdStrike ZTA) joining the row never
 * wraps onto a row of its own.
 */
export function KpiGrid({ children }: { children: ReactNode }) {
  const tiles = Children.count(children);
  return (
    <div
      className="grid auto-rows-fr grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-[repeat(var(--kpi-cols),minmax(0,1fr))] max-lg:[&>*]:min-w-0"
      style={{ '--kpi-cols': String(tiles) } as CSSProperties}
    >
      {children}
    </div>
  );
}
