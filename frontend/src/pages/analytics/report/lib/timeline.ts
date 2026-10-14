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

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: string }

function localParts(t: number, tz: string): LocalParts {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23', weekday: 'short',
    }).formatToParts(new Date(t)).map((x) => [x.type, x.value]),
  );
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second), weekday: p.weekday,
  };
}

/** Undo a DST shift after stepping by whole days. */
function realign(t: number, tz: string): number {
  const h = localParts(t, tz).hour;
  if (h === 23) return t + HOUR;
  if (h === 1) return t - HOUR;
  return t;
}

function localMidnights(from: number, to: number, tz: string): number[] {
  const p = localParts(from, tz);
  let t = realign(from - ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 - (from % 1000), tz);
  if (t < from) t = realign(t + DAY, tz);
  const out: number[] = [];
  while (t <= to) {
    out.push(t);
    t = realign(t + DAY, tz);
  }
  return out;
}

export interface Tick { t: number; label: string }

export function axisTicks(fromIso: string, toIso: string, bucket: TimeBucket, tz: string): Tick[] {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);

  if (bucket === 'hour') {
    const step = to - from <= 24 * HOUR ? 3 : 6;
    const p = localParts(from, tz);
    let t = from - p.second * 1000 - (from % 1000);
    if (p.minute !== 0 || p.second !== 0) t += (60 - p.minute) * 60_000;
    const ticks: Tick[] = [];
    for (; t <= to; t += HOUR) {
      const lp = localParts(t, tz);
      if (lp.hour % step !== 0) continue;
      ticks.push({ t, label: lp.hour === 0 ? `${lp.day} ${MONTHS[lp.month - 1]}` : `${String(lp.hour).padStart(2, '0')}:00` });
    }
    return ticks;
  }

  const midnights = localMidnights(from, to, tz).map((t) => ({ t, p: localParts(t, tz) }));
  if (bucket === 'day') {
    const mondays = midnights.filter(({ p }) => p.weekday === 'Mon');
    return (mondays.length >= 2 ? mondays : midnights).map(({ t, p }) => ({ t, label: `${p.day} ${MONTHS[p.month - 1]}` }));
  }
  if (bucket === 'week') {
    return midnights.filter(({ p }) => p.day === 1).map(({ t, p }) => ({ t, label: MONTHS[p.month - 1] }));
  }
  const yearly = to - from > 3 * 365 * DAY;
  return midnights
    .filter(({ p }) => p.day === 1 && (yearly ? p.month === 1 : (p.month - 1) % 3 === 0))
    .map(({ t, p }) => ({ t, label: `${MONTHS[p.month - 1]} ${p.year}` }));
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
