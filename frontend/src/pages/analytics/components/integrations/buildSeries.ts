// Merge execution and alert trend points into one chart series.

import type { IntegrationTrendPoint, TimeWindow } from '@/services/api/integrationTypes';
import { bucketExecutions } from './weeklyBuckets';

export interface TimelinePoint {
  date: string;
  tests: number;
  linked: number;
  organic: number;
}

/** Same rule as the backend trend interval: day up to 90 days, week beyond. */
export function intervalForWindow(window: TimeWindow): 'day' | 'week' {
  const days = (new Date(window.to).getTime() - new Date(window.from).getTime()) / 86_400_000;
  return days > 90 ? 'week' : 'day';
}

export function buildSeries(
  tests: Array<{ timestamp: string; total?: number }>,
  alerts: IntegrationTrendPoint[],
  window: TimeWindow,
): TimelinePoint[] {
  const execs = bucketExecutions(tests, intervalForWindow(window));
  const byDate = new Map<string, TimelinePoint>();
  for (const [date, total] of Object.entries(execs)) {
    byDate.set(date, { date, tests: total, linked: 0, organic: 0 });
  }
  for (const a of alerts) {
    const date = a.date.slice(0, 10);
    const row = byDate.get(date) ?? { date, tests: 0, linked: 0, organic: 0 };
    row.linked = a.linked;
    row.organic = Math.max(0, a.count - a.linked);
    byDate.set(date, row);
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}
