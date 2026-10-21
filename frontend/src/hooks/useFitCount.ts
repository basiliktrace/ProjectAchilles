import { useCallback, useEffect, useState, type RefCallback } from 'react';
import { DESKTOP_QUERY, useMediaQuery } from './useMediaQuery';

interface FitCountOptions {
  /** Fewest items to render, even when they don't all fit. */
  min: number;
  /** Most items to render, however much room there is. */
  max: number;
  /** Count used when nothing can be measured (stacked layout, jsdom, print). */
  fallback: number;
  /** Vertical gap between items, in px. */
  gap?: number;
}

/**
 * How many list items fit in a card whose height is set by its row.
 *
 * Measures the CONTAINER (a `flex-1 min-h-0 overflow-hidden` box), never the
 * list's own content, so rendering more items can't change the measurement
 * and loop. The item height comes from the first rendered item, so wrapped
 * rows are measured rather than assumed. Below `lg` there is no row height to
 * fill, so the fallback count applies.
 */
export function useFitCount({ min, max, fallback, gap = 0 }: FitCountOptions): {
  containerRef: RefCallback<HTMLElement>;
  itemRef: RefCallback<HTMLElement>;
  count: number;
} {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [item, setItem] = useState<HTMLElement | null>(null);
  const [fitted, setFitted] = useState<number | null>(null);

  const containerRef = useCallback<RefCallback<HTMLElement>>((el) => setContainer(el), []);
  const itemRef = useCallback<RefCallback<HTMLElement>>((el) => setItem(el), []);

  useEffect(() => {
    if (!desktop || !container || !item || typeof ResizeObserver === 'undefined') {
      setFitted(null);
      return;
    }
    const measure = () => {
      const available = container.getBoundingClientRect().height;
      const itemHeight = item.getBoundingClientRect().height;
      if (available <= 0 || itemHeight <= 0) {
        setFitted(null);
        return;
      }
      const n = Math.floor((available + gap) / (itemHeight + gap));
      setFitted(Math.min(max, Math.max(min, n)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    // Item height can change too (web fonts, wrapping on resize)
    observer.observe(item);
    return () => observer.disconnect();
  }, [desktop, container, item, gap, min, max]);

  return { containerRef, itemRef, count: fitted ?? fallback };
}
