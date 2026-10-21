import type { QueryDslQueryContainer } from '@elastic/elasticsearch/lib/api/types.js';
import { AppError } from '../../middleware/error.middleware.js';

export interface TimeWindow {
  from: string;
  to: string;
}

/** Alert feed source filter. Linked = f0rtika.achilles_correlated: true; organic = everything else. */
export type AlertSource = 'all' | 'test' | 'organic';

/** Facet counts behind the alert feed's filter segments and summary strip. */
export interface AlertFacetCounts {
  /** All filters except source. */
  bySource: { all: number; test: number; organic: number };
  /** All filters except severity. */
  bySeverity: Record<string, number>;
  /** All filters. Counts alerts Achilles really resolved (enabled, error-free receipt). */
  autoResolved: number;
  /** Window only: linked AND status NOT IN ('closed','resolved'). */
  linkedOpen: number;
  /** CrowdStrike only, all filters. */
  byPrevention?: { prevented: number; detected_only: number; kill_failed: number };
  /** Defender only, all filters. */
  byProduct?: Record<string, number>;
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

const ALERT_SOURCES: readonly string[] = ['all', 'test', 'organic'];

/** Parses req.query.source. Undefined when absent; AppError(400, 'Invalid source') otherwise. */
export function parseAlertSource(value: unknown): AlertSource | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'string' && ALERT_SOURCES.includes(value)) return value as AlertSource;
  throw new AppError('Invalid source', 400);
}

/** Parses a comma-separated severity list (`high` or `high,critical`). Undefined when empty. */
export function parseSeverityList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const list = String(value).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length > 0 ? list : undefined;
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
