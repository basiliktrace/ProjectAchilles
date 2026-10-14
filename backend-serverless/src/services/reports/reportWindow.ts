// Time-range rules for the execution report (spec §5.5).
//
// The window is resolved ONCE to absolute bounds so every query in one
// report sees the same `now`. The preset is derived from the bounds, never
// trusted from the caller, so the cover label can't disagree with the data.

import { AppError } from '../../middleware/error.middleware.js';
import type { TimeBucket } from '../../types/reports.js';

/** Lower bound the frontend sends for the "All time" preset. */
export const ALL_TIME_FROM = '2000-01-01T00:00:00.000Z';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Largest axis span (inclusive) each bucket size is used for. */
export const BUCKET_CEILINGS_MS = { hour: 48 * HOUR_MS, day: 60 * DAY_MS, week: 400 * DAY_MS } as const;

/** What buildDateFilter applies when neither bound is sent. */
const DEFAULT_LOWER_BOUND = 'now-7d';

const PRESET_LABELS: Record<string, string> = {
  '1d': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  all: 'All time',
  custom: 'Custom range',
};

export interface ResolvedWindow {
  preset: string;
  label: string;
  effectiveFrom: string;
  effectiveTo: string;
}

export interface TimeAxis {
  axisFrom: string;
  axisTo: string;
  bucket: TimeBucket;
}

const DATE_MATH = /^now(?:-(\d+)([smhdwMy]))?$/;

/**
 * Strict ISO bound: YYYY-MM-DD, or YYYY-MM-DDTHH:mm with optional :ss, optional
 * .fff and an optional Z or ±hh:mm. Checked before Date.parse, whose legacy
 * fallback accepts inputs like "12" or "Oct 5".
 */
const ISO_BOUND = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(Z|[+-]\d{2}:\d{2})?)?$/;

/** Resolve "now", "now-<n><unit>" or an ISO string to an absolute Date. */
export function parseBound(value: string, now: Date): Date {
  const text = value.trim();
  const m = text.match(DATE_MATH);
  if (m) {
    const d = new Date(now.getTime());
    if (!m[1]) return d;
    const n = parseInt(m[1], 10);
    switch (m[2]) {
      case 's': d.setTime(d.getTime() - n * 1000); break;
      case 'm': d.setTime(d.getTime() - n * 60_000); break;
      case 'h': d.setTime(d.getTime() - n * HOUR_MS); break;
      case 'd': d.setTime(d.getTime() - n * DAY_MS); break;
      case 'w': d.setTime(d.getTime() - n * 7 * DAY_MS); break;
      case 'M': d.setUTCMonth(d.getUTCMonth() - n); break;
      case 'y': d.setUTCFullYear(d.getUTCFullYear() - n); break;
    }
    // Huge counts overflow the Date range to Invalid Date; reject rather than return it.
    if (Number.isNaN(d.getTime())) throw new AppError(`Invalid date bound: ${value}`, 400);
    return d;
  }
  const iso = text.match(ISO_BOUND);
  if (!iso) throw new AppError(`Invalid date bound: ${value}`, 400);
  // An offset-less value is read as UTC, matching Elasticsearch's buildDateFilter.
  const [, date, time = '00:00', zone = 'Z'] = iso;
  const ms = Date.parse(`${date}T${time}${zone}`);
  if (Number.isNaN(ms)) throw new AppError(`Invalid date bound: ${value}`, 400);
  return new Date(ms);
}

export function resolveReportWindow(input: { from?: string; to?: string }, now: Date): ResolvedWindow {
  const fromRaw = input.from?.trim() || undefined;
  const toRaw = input.to?.trim() || undefined;

  const to = toRaw ? parseBound(toRaw, now) : now;
  let from: Date;
  if (fromRaw) from = parseBound(fromRaw, now);
  else if (toRaw) from = new Date(ALL_TIME_FROM); // only an upper bound: ES applies no lower bound
  else from = parseBound(DEFAULT_LOWER_BOUND, now);

  if (from.getTime() >= to.getTime()) throw new AppError('from must be before to', 400);

  const effectiveFrom = from.toISOString();
  const relative = fromRaw?.match(/^now-(\d+[hdw])$/)?.[1];
  const preset = effectiveFrom === ALL_TIME_FROM && !toRaw ? 'all'
    : !fromRaw && !toRaw ? '7d'
    : relative && relative in PRESET_LABELS && !toRaw ? relative
    : 'custom';

  return { preset, label: PRESET_LABELS[preset], effectiveFrom, effectiveTo: to.toISOString() };
}

export function chooseBucket(spanMs: number): TimeBucket {
  if (spanMs <= BUCKET_CEILINGS_MS.hour) return 'hour';
  if (spanMs <= BUCKET_CEILINGS_MS.day) return 'day';
  if (spanMs <= BUCKET_CEILINGS_MS.week) return 'week';
  return 'month';
}

/** Floor an instant to its bucket start in UTC (weeks start on Monday). */
export function floorToBucket(iso: string, bucket: TimeBucket): string {
  const d = new Date(iso);
  if (bucket === 'hour') {
    d.setUTCMinutes(0, 0, 0);
  } else {
    d.setUTCHours(0, 0, 0, 0);
    if (bucket === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    if (bucket === 'month') d.setUTCDate(1);
  }
  return d.toISOString();
}

/**
 * Timeline axis (spec §5.5 rule 4): a bounded window is shown in full, so
 * stretches with no testing stay visible. An unbounded window (lower bound
 * ALL_TIME_FROM) starts at the first execution.
 */
export function computeTimeAxis(win: ResolvedWindow, firstExecution: string | null): TimeAxis {
  const axisTo = win.effectiveTo;
  if (win.effectiveFrom !== ALL_TIME_FROM) {
    return {
      axisFrom: win.effectiveFrom,
      axisTo,
      bucket: chooseBucket(Date.parse(axisTo) - Date.parse(win.effectiveFrom)),
    };
  }
  const start = firstExecution ?? new Date(Date.parse(axisTo) - DAY_MS).toISOString();
  const bucket = chooseBucket(Date.parse(axisTo) - Date.parse(start));
  return { axisFrom: floorToBucket(start, bucket), axisTo, bucket };
}

export function validateTimeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    throw new AppError(`Unknown time zone: ${tz}`, 400);
  }
}
