import { useCallback, useLayoutEffect, useState, type RefCallback } from 'react';
import { DESKTOP_QUERY, useMediaQuery } from './useMediaQuery';

interface FitCountOptions {
  /** Fewest items to show, even when they don't all fit. */
  min: number;
  /** Most items to show, however much room there is. */
  max: number;
  /** Count used when nothing can be measured (stacked layout, jsdom, print). */
  fallback: number;
  /** Changes when the rendered items change, so they are re-measured. */
  itemsKey: string;
}

interface FitCount {
  containerRef: RefCallback<HTMLElement>;
  /** True when the container can be measured: render up to `max` items in it. */
  measuring: boolean;
  /** Items to show; with `measuring`, items past this are rendered hidden. */
  count: number;
  /** Bottom edge of the first `min` items, in px (0 until measured). */
  floor: number;
}

/**
 * How many list items fit a container whose height is set by its row.
 *
 * While measuring, all items up to `max` are rendered in an absolutely
 * positioned container (so they add nothing to the row's height) and the
 * count is the number of LEADING items whose bottom edge fits. Items after
 * that are hidden, not removed: earlier items never move, so the count can't
 * oscillate, and a grown container can show them again. Measuring each item
 * means rows of different heights are never cut in half. The floor (the
 * first `min` items' height) depends only on those items, never on the count.
 */
export function useFitCount({ min, max, fallback, itemsKey }: FitCountOptions): FitCount {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [fit, setFit] = useState<{ count: number; floor: number } | null>(null);
  const containerRef = useCallback<RefCallback<HTMLElement>>((el) => setContainer(el), []);
  const measuring = desktop && typeof ResizeObserver !== 'undefined';

  useLayoutEffect(() => {
    if (!measuring || !container) {
      setFit(null);
      return;
    }
    const measure = () => {
      const kids = [...container.children] as HTMLElement[];
      const available = container.clientHeight;
      if (kids.length === 0 || available <= 0) {
        setFit(null);
        return;
      }
      const bottom = (el: HTMLElement) => el.offsetTop + el.offsetHeight;
      let fitting = 0;
      // Half a pixel of slack for sub-pixel layout
      while (fitting < kids.length && bottom(kids[fitting]) <= available + 0.5) fitting++;
      const count = Math.min(max, kids.length, Math.max(min, fitting));
      const floor = bottom(kids[Math.min(min, kids.length) - 1]);
      setFit((prev) => (prev && prev.count === count && prev.floor === floor ? prev : { count, floor }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    // Item heights change too (web fonts, text re-wrapping on resize)
    for (const kid of container.children) observer.observe(kid);
    return () => observer.disconnect();
  }, [measuring, container, min, max, itemsKey]);

  return {
    containerRef,
    measuring,
    count: measuring ? (fit?.count ?? max) : fallback,
    floor: fit?.floor ?? 0,
  };
}
