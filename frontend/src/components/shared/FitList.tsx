import type { CSSProperties, ReactNode } from 'react';
import { useFitCount } from '@/hooks/useFitCount';

interface FitListProps<T> {
  items: T[];
  /** Fewest items to show, even when they don't all fit. */
  min: number;
  /** Most items to show, however much room there is. */
  max: number;
  /** Count used when nothing can be measured (stacked layout, jsdom, print). */
  fallback: number;
  /** Gap between items, in px. */
  gap?: number;
  getKey: (item: T, index: number) => string;
  children: (item: T, index: number) => ReactNode;
}

/**
 * A list that shows as many whole items as fit the height its row gives it.
 *
 * On large screens the list is absolutely positioned inside a `flex-1` box,
 * so it adds nothing to the card's intrinsic height: the row's anchor card
 * sets the height and this list fills it. The box keeps a floor tall enough
 * for `min` items. Below `lg` it flows normally and shows `fallback` items.
 */
export function FitList<T>({ items, min, max, fallback, gap = 8, getKey, children }: FitListProps<T>) {
  const rendered = items.slice(0, max);
  const itemsKey = rendered.map((item, i) => getKey(item, i)).join('\u0000');
  const { containerRef, measuring, count, floor } = useFitCount({ min, max, fallback, itemsKey });
  const shown = measuring ? rendered : items.slice(0, count);

  return (
    <div className="relative flex-1 lg:min-h-[var(--fit-min)]" style={{ '--fit-min': `${floor}px` } as CSSProperties}>
      <div
        ref={containerRef}
        data-fit-container=""
        className="flex flex-col overflow-hidden lg:absolute lg:inset-0"
        style={{ gap }}
      >
        {shown.map((item, index) => {
          const hidden = measuring && index >= count;
          return (
            <div
              key={getKey(item, index)}
              className="shrink-0"
              style={hidden ? { visibility: 'hidden' } : undefined}
              aria-hidden={hidden || undefined}
            >
              {children(item, index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
