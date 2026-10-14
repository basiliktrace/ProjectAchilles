// Campaign-timeline rules (spec §5.5). Pure functions; the diagram only draws.
import type { ReportTimelineBucket, ReportWindow, TimeBucket } from '@/services/api/reports';
import { conclusive, protectionRate, sumCounts } from './outcomes';
import { fmtDateTime } from './format';

export const GLYPH_GAP_PX = 10;
export const MAX_SHIFT_PX = 12;
export const TREND_MIN_RESULTS = 5;
export const HALF_MIN_RESULTS = 10;

const HOUR = 3_600_000;
const DAY = 86_400_000;
const QUARTER_HOUR = 900_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function bucketMs(bucket: TimeBucket): number {
  return bucket === 'hour' ? HOUR : bucket === 'day' ? DAY : bucket === 'week' ? 7 * DAY : 30 * DAY;
}

export function timeScale(fromIso: string, toIso: string, x0: number, x1: number): (t: string | number) => number {
  const a = Date.parse(fromIso);
  const span = Math.max(1, Date.parse(toIso) - a);
  return (t) => x0 + (((typeof t === 'number' ? t : Date.parse(t)) - a) / span) * (x1 - x0);
}

/** Left-to-right packing with a minimum gap; positions come back in input order. */
export function packPositions(xs: number[], gap = GLYPH_GAP_PX): number[] {
  const order = xs.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
  const out = new Array<number>(xs.length);
  let last = -Infinity;
  for (const [x, i] of order) {
    const pos = Math.max(x, last + gap);
    out[i] = pos;
    last = pos;
  }
  return out;
}

/** Glyph mode only when the runs list is complete and no run moves more than MAX_SHIFT_PX. */
export function canUseGlyphs(laneXs: number[][], runsComplete: boolean): boolean {
  if (!runsComplete) return false;
  return laneXs.every((xs) => {
    const packed = packPositions(xs);
    return packed.every((p, i) => p - xs[i] <= MAX_SHIFT_PX);
  });
}

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

const formatters = new Map<string, Intl.DateTimeFormat>();

function localParts(t: number, tz: string): LocalParts {
  let fmt = formatters.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
    });
    formatters.set(tz, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second),
  };
}

/** A calendar date with no time and no zone. month is 1-12. */
interface CalDate { year: number; month: number; day: number }

const sameDate = (a: CalDate, b: CalDate) => a.year === b.year && a.month === b.month && a.day === b.day;

function calDateOf(t: number, tz: string): CalDate {
  const p = localParts(t, tz);
  return { year: p.year, month: p.month, day: p.day };
}

/** The calendar date after `c`, by UTC date arithmetic (no zone, so no DST). */
function nextDate(c: CalDate): CalDate {
  const d = new Date(Date.UTC(c.year, c.month - 1, c.day + 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Zone offset in ms at instant t, to the second. */
function offsetAt(t: number, tz: string): number {
  const p = localParts(t, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}

/**
 * Earliest instant whose local calendar date is `c`. That is local 00:00 whenever the zone has
 * it. If the zone jumps over midnight (spring-forward at 00:00), it is the first existing time of
 * that date (01:00 for a one-hour change). A jump that starts before midnight, e.g. 23:30 to
 * 00:30, lands on the first whole hour after it, which is still on that date. Null when the zone
 * skips the whole date (Pacific/Apia, 30 Dec 2011).
 */
function firstInstantOf(c: CalDate, tz: string): number | null {
  // 00:00 wall clock read as UTC; local midnight sits at guess - offset.
  const guess = Date.UTC(c.year, c.month - 1, c.day);
  // Offsets a day either side of midnight, so both sides of any transition near it are sampled.
  const offsets = new Set([-DAY, 0, DAY].map((k) => offsetAt(guess + k, tz)));
  const hits = Array.from(offsets).map((o) => guess - o).filter((t) => sameDate(calDateOf(t, tz), c));
  return hits.length > 0 ? Math.min(...hits) : null;
}

interface DayStart { t: number; date: CalDate }

/** The first instant of every local date with a start in [from, to], each date once, in order. */
function dayStarts(from: number, to: number, tz: string): DayStart[] {
  const out: DayStart[] = [];
  const last = to + 2 * DAY;
  for (let c = calDateOf(from, tz); Date.UTC(c.year, c.month - 1, c.day) <= last; c = nextDate(c)) {
    const t = firstInstantOf(c, tz);
    if (t !== null && t >= from && t <= to) out.push({ t, date: c });
  }
  return out;
}

/** 0 = Sunday ... 1 = Monday. */
const weekday = (c: CalDate) => new Date(Date.UTC(c.year, c.month - 1, c.day)).getUTCDay();

const dayLabel = (c: CalDate) => `${c.day} ${MONTHS[c.month - 1]}`;

export interface Tick { t: number; label: string }

export function axisTicks(fromIso: string, toIso: string, bucket: TimeBucket, tz: string): Tick[] {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  const dates = dayStarts(from, to, tz);

  if (bucket === 'hour') {
    const step = to - from <= 24 * HOUR ? 3 : 6;
    const ticks: Tick[] = dates.map(({ t, date }) => ({ t, label: dayLabel(date) }));
    // A 15-minute grid reaches local :00 for every zone offset, including 30-minute DST changes.
    const seen = new Set<string>();
    for (let t = Math.ceil(from / QUARTER_HOUR) * QUARTER_HOUR; t <= to; t += QUARTER_HOUR) {
      const p = localParts(t, tz);
      // Local midnight is labelled by its date above; skip it here and skip a repeated hour after fall-back.
      if (p.minute !== 0 || p.hour === 0 || p.hour % step !== 0) continue;
      const key = `${p.year}-${p.month}-${p.day}-${p.hour}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ticks.push({ t, label: `${String(p.hour).padStart(2, '0')}:00` });
    }
    return ticks.sort((a, b) => a.t - b.t);
  }

  if (bucket === 'day') {
    const mondays = dates.filter(({ date }) => weekday(date) === 1);
    return (mondays.length >= 2 ? mondays : dates).map(({ t, date }) => ({ t, label: dayLabel(date) }));
  }
  if (bucket === 'week') {
    return dates.filter(({ date }) => date.day === 1).map(({ t, date }) => ({ t, label: MONTHS[date.month - 1] }));
  }
  const yearly = to - from > 3 * 365 * DAY;
  return dates
    .filter(({ date }) => date.day === 1 && (yearly ? date.month === 1 : (date.month - 1) % 3 === 0))
    .map(({ t, date }) => ({ t, label: `${MONTHS[date.month - 1]} ${date.year}` }));
}

/** One point per bucket with enough results; sparse buckets leave gaps. */
export function trendPoints(buckets: ReportTimelineBucket[]): { t: number; rate: number }[] {
  return buckets.flatMap((b) => {
    const c = sumCounts(b.lanes.map((l) => l.outcomes));
    const rate = protectionRate(c);
    return rate !== null && conclusive(c) >= TREND_MIN_RESULTS ? [{ t: Date.parse(b.start), rate }] : [];
  });
}

/** First-half vs second-half stage protection rate (works at any span). */
export function halvesTrend(
  buckets: ReportTimelineBucket[],
  axisFrom: string,
  axisTo: string,
): { first: number; second: number } | null {
  const mid = (Date.parse(axisFrom) + Date.parse(axisTo)) / 2;
  const half = (pick: (t: number) => boolean) =>
    sumCounts(buckets.filter((b) => pick(Date.parse(b.start))).flatMap((b) => b.lanes.map((l) => l.outcomes)));
  const first = half((t) => t < mid);
  const second = half((t) => t >= mid);
  if (conclusive(first) < HALF_MIN_RESULTS || conclusive(second) < HALF_MIN_RESULTS) return null;
  return { first: protectionRate(first) ?? 0, second: protectionRate(second) ?? 0 };
}

/** Note when executions cover less than a quarter of the axis (spec §5.5 rule 4). */
export function coverageNote(win: ReportWindow, tz: string): string | null {
  if (!win.firstExecution || !win.lastExecution) return null;
  const span = Date.parse(win.axisTo) - Date.parse(win.axisFrom);
  const covered = Date.parse(win.lastExecution) - Date.parse(win.firstExecution);
  if (span <= 0 || covered / span >= 0.25) return null;
  return `Executions only between ${fmtDateTime(win.firstExecution, tz)} and ${fmtDateTime(win.lastExecution, tz)}.`;
}
