import type { QueryDslQueryContainer } from '@elastic/elasticsearch/lib/api/types.js';
import { AppError } from '../../middleware/error.middleware.js';

export interface TimeWindow {
  from: string;
  to: string;
}

/** Alert feed source filter. Linked = f0rtika.achilles_correlated: true; organic = everything else. */
export type AlertSource = 'all' | 'test' | 'organic';

/**
 * Facet counts behind the alert feed's filter segments and summary strip.
 * Every count sees the window, search, techniques and status filters;
 * severity only ever filters the listed hits.
 */
export interface AlertFacetCounts {
  /** Ignores source and severity, so `all` equals the alerts tile. */
  bySource: { all: number; test: number; organic: number };
  /** Honours source, ignores severity. */
  bySeverity: Record<string, number>;
  /** Honours source, ignores severity. Counts alerts Achilles really resolved (enabled, error-free receipt). */
  autoResolved: number;
  /** Window only: linked AND status NOT IN ('closed','resolved'). */
  linkedOpen: number;
  /** CrowdStrike only. Honours source, ignores severity. */
  byPrevention?: { prevented: number; detected_only: number; kill_failed: number };
  /** Defender only. Honours source, ignores severity. */
  byProduct?: Record<string, number>;
}

const DAY_MS = 86_400_000;

// Strict ISO 8601 only: a date (`YYYY-MM-DD`, UTC midnight) or a date-time
// with seconds, an optional fraction and an explicit `Z` / `±HH:MM` zone.
// Anything Date.parse merely tolerates ("Oct 20 2026", "2026/10/20", "1",
// zone-less date-times) is rejected, because ES would read it differently
// (epoch_millis, UTC) or answer with a parse_exception.
const ISO_BOUND =
  /^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/;

/** Epoch ms of a strict ISO bound, or NaN. Rejects non-calendar dates (2026-02-30). */
function parseIsoBound(value: string): number {
  const m = ISO_BOUND.exec(value);
  if (!m) return NaN;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return NaN;
  return Date.parse(value);
}

/**
 * Parses req.query.from/to. Returns null when both are absent.
 * Throws AppError(400, 'Invalid from/to') when either is not strict ISO 8601,
 * only one is given, or from >= to. Both bounds come back as toISOString().
 */
export function parseWindowQuery(query: Record<string, unknown>): TimeWindow | null {
  const { from, to } = query;
  const hasFrom = from !== undefined && from !== '';
  const hasTo = to !== undefined && to !== '';
  if (!hasFrom && !hasTo) return null;
  if (!hasFrom || !hasTo || typeof from !== 'string' || typeof to !== 'string') {
    throw new AppError('Invalid from/to', 400);
  }
  const f = parseIsoBound(from);
  const t = parseIsoBound(to);
  if (Number.isNaN(f) || Number.isNaN(t) || f >= t) {
    throw new AppError('Invalid from/to', 400);
  }
  return { from: new Date(f).toISOString(), to: new Date(t).toISOString() };
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
