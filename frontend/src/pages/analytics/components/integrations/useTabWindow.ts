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
 * ISO from/to ('all' = all time). `refresh()` (Sync Now) re-resolves it,
 * re-anchoring relative presets at "now", and bumps `refreshKey`. A custom
 * range resolves to the same from/to, so cards that key their fetches on the
 * window strings must also depend on `refreshKey`. An unusable custom range
 * falls back to the default range, and `windowLabel` then describes that.
 */
export function useTabWindow(dateRange: DateRangeValue): {
  window: TimeWindow;
  windowLabel: string;
  refreshKey: number;
  refresh: () => void;
} {
  const { preset, from, to } = dateRange;
  const [refreshKey, setRefreshKey] = useState(0);
  const resolved = useMemo(
    () => {
      const range = { preset, from, to };
      const window = resolveTimeWindow(range, { allTime: true });
      if (window) return { window, windowLabel: timeRangeLabel(range) };
      return {
        window: resolveTimeWindow(DEFAULT_TIME_RANGE) as TimeWindow,
        windowLabel: timeRangeLabel(DEFAULT_TIME_RANGE),
      };
    },
    // `refreshKey` is deliberately a dependency: bumping it re-resolves the window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preset, from, to, refreshKey],
  );
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  return { window: resolved.window, windowLabel: resolved.windowLabel, refreshKey, refresh };
}
