/**
 * The time range shared by the Dashboard and Analytics pages.
 *
 * A change on either page is remembered for the browser-tab session
 * (sessionStorage), so the other page opens on the same window. A range in
 * the URL always wins and becomes the remembered one, so shared links stay
 * exact. The default is omitted from URLs.
 */

export interface DateRangeValue {
  preset: string;
  from?: string; // ISO date string for custom range
  to?: string; // ISO date string for custom range
}

export const TIME_RANGE_PRESETS = ['1d', '7d', '30d', '90d', 'all'] as const;

export const DEFAULT_TIME_RANGE: DateRangeValue = { preset: '30d' };

/**
 * Lower bound sent for the "All time" preset. With no dates at all the
 * backend falls back to the last 7 days, so "All time" must send one.
 * Must equal ALL_TIME_FROM in backend/src/services/reports/reportWindow.ts.
 */
export const ALL_TIME_FROM = '2000-01-01T00:00:00.000Z';

const STORAGE_KEY = 'achilles.timeRange';
const DAY_MS = 86_400_000;
/** Longest window the Defender / CrowdStrike score trends are asked for. */
const MAX_TREND_DAYS = 365;

function isPreset(value: string): boolean {
  return (TIME_RANGE_PRESETS as readonly string[]).includes(value);
}

export function isValidTimeRange(value: unknown): value is DateRangeValue {
  if (!value || typeof value !== 'object') return false;
  const { preset, from, to } = value as Record<string, unknown>;
  if (typeof preset !== 'string') return false;
  if (preset === 'custom') {
    return (
      typeof from === 'string' &&
      typeof to === 'string' &&
      !Number.isNaN(Date.parse(from)) &&
      !Number.isNaN(Date.parse(to))
    );
  }
  return isPreset(preset);
}

function normalize(value: DateRangeValue): DateRangeValue {
  return value.preset === 'custom'
    ? { preset: 'custom', from: value.from, to: value.to }
    : { preset: value.preset };
}

export function isSameTimeRange(a: DateRangeValue, b: DateRangeValue): boolean {
  return a.preset === b.preset && a.from === b.from && a.to === b.to;
}

/** The remembered range, or null when none is stored (or storage is unavailable). */
export function readStoredTimeRange(): DateRangeValue | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValidTimeRange(parsed) ? normalize(parsed) : null;
  } catch {
    return null;
  }
}

export function storeTimeRange(value: DateRangeValue): void {
  if (!isValidTimeRange(value)) return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(normalize(value)));
  } catch {
    // Private mode / blocked storage: the range just isn't remembered.
  }
}

/**
 * Range from URL params: `date=<preset>`, or `from` + `to` for a custom
 * range. `legacyKey` also reads an older single-preset param (the
 * Dashboard's `range=`). Null when the URL carries no valid range.
 */
export function timeRangeFromParams(
  params: URLSearchParams,
  legacyKey?: string,
): DateRangeValue | null {
  const preset = params.get('date') ?? (legacyKey ? params.get(legacyKey) : null);
  if (preset && preset !== 'custom') {
    return isPreset(preset) ? { preset } : null;
  }
  const from = params.get('from');
  const to = params.get('to');
  const custom = { preset: 'custom', from: from ?? undefined, to: to ?? undefined };
  return isValidTimeRange(custom) ? custom : null;
}

/** URL params for a range; the default range serializes to nothing. */
export function timeRangeToParams(value: DateRangeValue): Record<string, string> {
  if (value.preset === 'custom' && value.from && value.to) {
    return { from: value.from, to: value.to };
  }
  if (value.preset && value.preset !== DEFAULT_TIME_RANGE.preset) {
    return { date: value.preset };
  }
  return {};
}

/** URL first, then the remembered range, then the default. */
export function resolveTimeRange(params: URLSearchParams, legacyKey?: string): DateRangeValue {
  return timeRangeFromParams(params, legacyKey) ?? readStoredTimeRange() ?? DEFAULT_TIME_RANGE;
}

/** Convert a date range value to the API's from/to (ES date math or ISO). */
export function getDateRangeFilter(value: DateRangeValue): { from?: string; to?: string } {
  if (value.preset === 'custom' && value.from && value.to) {
    return { from: value.from, to: value.to };
  }
  if (value.preset === 'all') {
    return { from: ALL_TIME_FROM };
  }
  const match = value.preset.match(/^(\d+)([dhw])$/);
  if (!match) {
    return { from: `now-${DEFAULT_TIME_RANGE.preset}` };
  }
  return { from: `now-${value.preset}` };
}

/** Whole days covered by a range, for the day-count score trends (1-365). */
export function timeRangeDays(value: DateRangeValue): number {
  let days: number;
  if (value.preset === 'custom' && value.from && value.to) {
    days = Math.ceil((Date.parse(value.to) - Date.parse(value.from)) / DAY_MS);
  } else if (value.preset === 'all') {
    days = MAX_TREND_DAYS;
  } else {
    const match = value.preset.match(/^(\d+)([dhw])$/);
    const unitDays: Record<string, number> = { h: 1 / 24, d: 1, w: 7 };
    days = match ? Math.ceil(parseInt(match[1], 10) * unitDays[match[2]]) : 30;
  }
  if (!Number.isFinite(days)) return 30;
  return Math.min(MAX_TREND_DAYS, Math.max(1, days));
}

/** Short button label for a preset: 24h, 7d, 30d, 90d, All. */
export function timeRangeButtonLabel(preset: string): string {
  if (preset === '1d') return '24h';
  if (preset === 'all') return 'All';
  return preset;
}

/**
 * Resolve a range to a concrete ISO `{from, to}` window (relative presets are
 * anchored to `now`). 'all' maps to the last 90 days unless `allTime` is set,
 * which sends ALL_TIME_FROM. Null when the range is unusable or from >= to.
 */
export function resolveTimeWindow(
  range: DateRangeValue,
  opts: { allTime?: boolean; now?: Date } = {},
): { from: string; to: string } | null {
  const now = opts.now ?? new Date();

  if (range.preset === 'custom' && range.from && range.to) {
    const from = new Date(range.from);
    const to = new Date(range.to);
    // A date-only 'to' bound should include that whole day
    if (!range.to.includes('T')) to.setHours(23, 59, 59, 999);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return null;
    return { from: from.toISOString(), to: to.toISOString() };
  }

  if (range.preset === 'all' && opts.allTime) {
    return { from: ALL_TIME_FROM, to: now.toISOString() };
  }

  const preset = range.preset === 'all' ? '90d' : range.preset;
  const match = preset.match(/^(\d+)([dhw])$/);
  if (!match) return null;
  const unitMs: Record<string, number> = { d: DAY_MS, h: 3_600_000, w: 7 * DAY_MS };
  const from = new Date(now.getTime() - parseInt(match[1], 10) * unitMs[match[2]]);
  return { from: from.toISOString(), to: now.toISOString() };
}

/** Lower-case phrase for headings and captions: "last 30 days", "all time". */
export function timeRangeLabel(range: DateRangeValue): string {
  if (range.preset === 'custom') return 'selected range';
  if (range.preset === 'all') return 'all time';
  if (range.preset === '1d') return 'last 24 hours';
  const match = range.preset.match(/^(\d+)([dhw])$/);
  if (!match) return 'selected range';
  const unit = { d: 'day', h: 'hour', w: 'week' }[match[2]]!;
  const n = parseInt(match[1], 10);
  return `last ${n} ${unit}${n === 1 ? '' : 's'}`;
}
