import type { CSSProperties, ReactNode } from 'react';
import { useFitCount } from '@/hooks/useFitCount';

interface FitListProps<T> {
  items: T[];
  /** Fewest items to render, even when they don't all fit. */
  min: number;
  /** Most items to render, however much room there is. */
  max: number;
  /** Count used when nothing can be measured (stacked layout, jsdom, print). */
  fallback: number;
  /** Gap between items, in px. */
  gap?: number;
  /** Large-screen floor for the list area, so a short row still shows `min` items. */
  minHeight?: number;
  getKey: (item: T, index: number) => string;
  children: (item: T, index: number) => ReactNode;
}

/**
 * A list that shows as many items as fit the height its row gives it.
 *
 * On large screens the list is absolutely positioned inside a `flex-1` box,
 * so it adds nothing to the card's intrinsic height: the row's anchor card
 * sets the height and this list fills it. Below `lg` it flows normally and
 * shows `fallback` items.
 */
export function FitList<T>({ items, min, max, fallback, gap = 8, minHeight = 120, getKey, children }: FitListProps<T>) {
  const { containerRef, itemRef, count } = useFitCount({ min, max, fallback, gap });
  return (
    <div className="relative flex-1 lg:min-h-[var(--fit-min)]" style={{ '--fit-min': `${minHeight}px` } as CSSProperties}>
      <div ref={containerRef} className="flex flex-col overflow-hidden lg:absolute lg:inset-0" style={{ gap }}>
        {items.slice(0, count).map((item, index) => (
          <div key={getKey(item, index)} ref={index === 0 ? itemRef : undefined} className="shrink-0">
            {children(item, index)}
          </div>
        ))}
      </div>
    </div>
  );
}
