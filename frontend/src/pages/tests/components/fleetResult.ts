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
 * Format a test's fleet result cell. "Not run in 90 days" is only claimed once the
 * fetch has succeeded; while it is pending or has failed the cell stays neutral.
 */
export function fleetResultText(
  test: TestMetadata,
  item: TestResultItem | undefined,
  state: FleetState,
): FleetResult {
  if (state === 'loading') {
    return { text: PLACEHOLDER, share: null, title: 'Loading fleet results' };
  }
  if (state === 'error') {
    return { text: PLACEHOLDER, share: null, title: 'Fleet results unavailable' };
  }
  if (!item || item.pairCount <= 0) {
    return { text: 'Not run in 90 days', share: null, title: 'No results from any endpoint in the last 90 days' };
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
