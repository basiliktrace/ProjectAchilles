import type { QueryDslQueryContainer } from '@elastic/elasticsearch/lib/api/types.js';
import { AppError } from '../../middleware/error.middleware.js';

export interface TimeWindow {
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;

/**
 * Parses req.query.from/to. Returns null when both are absent.
 * Throws AppError(400, 'Invalid from/to') when either is unparsable,
 * only one is given, or from >= to.
 */
export function parseWindowQuery(query: Record<string, unknown>): TimeWindow | null {
  const { from, to } = query;
  const hasFrom = from !== undefined && from !== '';
  const hasTo = to !== undefined && to !== '';
  if (!hasFrom && !hasTo) return null;
  if (!hasFrom || !hasTo || typeof from !== 'string' || typeof to !== 'string') {
    throw new AppError('Invalid from/to', 400);
  }
  const f = Date.parse(from);
  const t = Date.parse(to);
  if (Number.isNaN(f) || Number.isNaN(t) || f >= t) {
    throw new AppError('Invalid from/to', 400);
  }
  return { from, to };
}

/** ES range clause on `field`, or null for a null window. */
export function windowRange(field: string, window: TimeWindow | null): QueryDslQueryContainer | null {
  if (!window) return null;
  return { range: { [field]: { gte: window.from, lte: window.to } } };
}

/** 'day' when (to - from) <= 90 days, else 'week'. */
export function trendInterval(window: TimeWindow): 'day' | 'week' {
  const span = Date.parse(window.to) - Date.parse(window.from);
  return span <= 90 * DAY_MS ? 'day' : 'week';
}
