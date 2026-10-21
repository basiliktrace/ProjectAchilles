import { useCallback, useMemo, useState } from 'react';
import {
  DEFAULT_TIME_RANGE,
  resolveTimeWindow,
  timeRangeLabel,
  type DateRangeValue,
} from '@/lib/timeRange';
import type { TimeWindow } from '@/services/api/integrationTypes';

/**
 * The integration tab's one window (spec D2): the page date range resolved to
 * ISO from/to ('all' = all time). `refresh()` re-resolves it, re-anchoring
 * relative presets at "now" and handing every consumer a new window object,
 * so Sync Now reloads everything. An unusable custom range falls back to the
 * default range rather than leaving the tab without a window.
 */
export function useTabWindow(dateRange: DateRangeValue): {
  window: TimeWindow;
  windowLabel: string;
  refresh: () => void;
} {
  const { preset, from, to } = dateRange;
  const [anchor, setAnchor] = useState(0);
  const window = useMemo(
    () => {
      const range = { preset, from, to };
      return (
        resolveTimeWindow(range, { allTime: true }) ??
        (resolveTimeWindow(DEFAULT_TIME_RANGE) as TimeWindow)
      );
    },
    // `anchor` is deliberately a dependency: bumping it re-resolves the window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preset, from, to, anchor],
  );
  const refresh = useCallback(() => setAnchor((a) => a + 1), []);
  return { window, windowLabel: timeRangeLabel(dateRange), refresh };
}
