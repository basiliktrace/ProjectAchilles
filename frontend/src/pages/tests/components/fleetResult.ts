import type { TestMetadata } from '@/types/test';
import type { TestResultItem } from '@/services/api/analytics';
import { formatRelativeDate } from '@/utils/dateFormatters';

/** Where the page-wide fleet-results fetch stands. Unconfigured analytics counts as `error`. */
export type FleetState = 'loading' | 'error' | 'ready';

export interface FleetResult {
  text: string;
  /** Protected share in [0, 1] for the bar, or null when there is nothing to draw. */
  share: number | null;
  title: string;
}

const PLACEHOLDER = '—';

/**
 * Format a test's fleet result cell. The fleet fetch only counts conclusive results
 * (protected/unprotected) from the last 90 days, so a missing item does not mean the
 * test never ran. `executed` says whether the all-time, any-outcome executed set
 * contains the test: true/false when that set loaded, null when unknown. While the
 * fleet fetch is pending or has failed the cell stays neutral.
 */
export function fleetResultText(
  test: TestMetadata,
  item: TestResultItem | undefined,
  state: FleetState,
  executed: boolean | null,
): FleetResult {
  if (state === 'loading') {
    return { text: PLACEHOLDER, share: null, title: 'Loading fleet results' };
  }
  if (state === 'error') {
    return { text: PLACEHOLDER, share: null, title: 'Fleet results unavailable' };
  }
  if (!item || item.pairCount <= 0) {
    if (executed === false) {
      return { text: 'Not run yet', share: null, title: 'No results from any endpoint' };
    }
    return {
      text: 'No conclusive result in 90 days',
      share: null,
      title:
        "No endpoint returned protected or unprotected in the last 90 days. Errors, blocks before execution, skipped stages and risk-accepted results don't count.",
    };
  }

  const noun = test.category === 'cyber-hygiene' ? 'checks passed' : 'endpoints protected';
  const lastRun = Number.isNaN(new Date(item.lastRunAt).getTime())
    ? ''
    : ` · last run ${formatRelativeDate(item.lastRunAt)}`;

  return {
    text: `${item.protectedCount} / ${item.pairCount} ${noun}`,
    share: item.protectedCount / item.pairCount,
    title: `Latest result per endpoint, last 90 days${lastRun}`,
  };
}
