/**
 * Latest-result posture: the share of test x endpoint pairs whose latest
 * conclusive result inside a freshness window is protected.
 *
 * Pure and Elasticsearch-free on purpose (no project imports) so it can be
 * copied verbatim into backend-serverless/.
 */

export const MAX_FRESHNESS_DAYS = 365;
export const WEEKLY_STEP_THRESHOLD_DAYS = 90;
export const CONCLUSIVE_CODES = [101, 105, 126, 127] as const;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export interface PairRun {
  pairKey: string;
  ts: number; // epoch ms of the run (routing.event_time)
  protected: boolean; // combined rule; any-stage bundle: any control combined-protected
  strictProtected: boolean; // is_protected; any-stage bundle: any control is_protected
  errorCodes: number[]; // conclusive codes present in the run
  errorNames: string[];
  hostname: string;
  testName: string; // per-doc: f0rtika.test_name; any-stage bundle: bundle_name
  category?: string;
  subcategory?: string;
  techniques: string[];
}
export interface PostureWindow {
  fromMs: number;
  toMs: number;
  freshnessMs: number;
  step: 'day' | 'week';
  label: string;
}
export interface PostureSummary {
  pairCount: number;
  protectedCount: number;
  strictProtectedCount: number;
  score: number | null;
  strictScore: number | null;
}
export interface PosturePoint {
  timestamp: string;
  score: number | null;
  total: number;
  protected: number;
  strictScore: number | null;
}
export interface OutcomeFilters {
  result?: 'all' | 'protected' | 'unprotected' | 'inconclusive';
  errorCodes?: number[];
  errorNames?: string[];
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

function parseTime(value: string, nowMs: number): number {
  const m = value.match(/^now(?:-(\d+)([dhwmM]))?$/);
  if (m) {
    if (!m[1]) return nowMs;
    return nowMs - relativeMs(parseInt(m[1], 10), m[2]);
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? nowMs : t;
}

function relativeMs(n: number, unit: string): number {
  switch (unit) {
    case 'h':
      return n * HOUR_MS;
    case 'w':
      return n * 7 * DAY_MS;
    case 'm':
    case 'M':
      return n * 30 * DAY_MS;
    default:
      return n * DAY_MS;
  }
}

export function resolvePostureWindow(
  from: string | undefined,
  to: string | undefined,
  nowMs: number,
): PostureWindow {
  const toMs = to ? parseTime(to, nowMs) : nowMs;
  const fromMsRaw = from ? parseTime(from, nowMs) : toMs - 7 * DAY_MS;
  let freshnessMs = Math.max(0, toMs - fromMsRaw);
  const maxMs = MAX_FRESHNESS_DAYS * DAY_MS;

  let label: string;
  if (freshnessMs > maxMs) {
    freshnessMs = maxMs;
    label = `last ${MAX_FRESHNESS_DAYS}d`;
  } else {
    label = `${Math.ceil(freshnessMs / DAY_MS)}d`;
  }

  return {
    fromMs: toMs - freshnessMs,
    toMs,
    freshnessMs,
    step: freshnessMs > WEEKLY_STEP_THRESHOLD_DAYS * DAY_MS ? 'week' : 'day',
    label,
  };
}

export function latestPairsAsOf(runs: PairRun[], asOfMs: number, freshnessMs: number): PairRun[] {
  const latest = new Map<string, PairRun>();
  for (const r of runs) {
    if (r.ts > asOfMs) continue;
    const cur = latest.get(r.pairKey);
    if (!cur || r.ts >= cur.ts) latest.set(r.pairKey, r);
  }
  return freshOnly(latest, asOfMs, freshnessMs);
}

function freshOnly(latest: Map<string, PairRun>, asOfMs: number, freshnessMs: number): PairRun[] {
  const cutoff = asOfMs - freshnessMs;
  const out: PairRun[] = [];
  for (const r of latest.values()) {
    if (r.ts >= cutoff) out.push(r);
  }
  return out;
}

/**
 * Outcome filters, applied AFTER the latest pick ("pairs whose latest result is X").
 * `result=protected|unprotected` follows the pair's combined verdict
 * (`p.protected`), the same rule the Defense Score counts: a Defender- or
 * CrowdStrike-detected 101 is protected, and an any-stage bundle run with mixed
 * control codes matches exactly one of the two. `errorCodes`/`errorNames` stay
 * code-based: they match any code/name present in the run.
 */
export function applyOutcomeFilters(pairs: PairRun[], f: OutcomeFilters): PairRun[] {
  const result = f.result ?? 'all';
  if (result === 'inconclusive') return [];
  const codes = f.errorCodes && f.errorCodes.length > 0 ? f.errorCodes : undefined;
  const names = f.errorNames && f.errorNames.length > 0 ? f.errorNames : undefined;
  if (result === 'all' && !codes && !names) return pairs;

  return pairs.filter((p) => {
    if (result === 'protected' && !p.protected) return false;
    if (result === 'unprotected' && p.protected) return false;
    if (codes && !p.errorCodes.some((c) => codes.includes(c))) return false;
    if (names && !p.errorNames.some((n) => names.includes(n))) return false;
    return true;
  });
}

export function summarizePairs(pairs: PairRun[]): PostureSummary {
  let protectedCount = 0;
  let strictProtectedCount = 0;
  for (const p of pairs) {
    if (p.protected) protectedCount++;
    if (p.strictProtected) strictProtectedCount++;
  }
  const pairCount = pairs.length;
  return {
    pairCount,
    protectedCount,
    strictProtectedCount,
    score: pairCount === 0 ? null : round2((protectedCount / pairCount) * 100),
    strictScore: pairCount === 0 ? null : round2((strictProtectedCount / pairCount) * 100),
  };
}

function pointTimes(w: PostureWindow): number[] {
  const dayEnds: number[] = [];
  const lastDayStart = Math.floor(w.toMs / DAY_MS) * DAY_MS;
  for (let d = Math.floor(w.fromMs / DAY_MS) * DAY_MS; d < lastDayStart; d += DAY_MS) {
    dayEnds.push(d + DAY_MS - 1);
  }
  const times =
    w.step === 'week'
      ? dayEnds.filter((_, i) => (dayEnds.length - i) % 7 === 0) // 7th, 14th... day end back from toMs
      : dayEnds;
  times.push(w.toMs);
  return times;
}

export function postureSeries(runs: PairRun[], w: PostureWindow, f: OutcomeFilters): PosturePoint[] {
  const sorted = runs.slice().sort((a, b) => a.ts - b.ts);
  const latest = new Map<string, PairRun>();
  let idx = 0;

  return pointTimes(w).map((t) => {
    while (idx < sorted.length && sorted[idx].ts <= t) {
      latest.set(sorted[idx].pairKey, sorted[idx]);
      idx++;
    }
    const s = summarizePairs(applyOutcomeFilters(freshOnly(latest, t, w.freshnessMs), f));
    return {
      timestamp: new Date(t).toISOString(),
      score: s.score,
      total: s.pairCount,
      protected: s.protectedCount,
      strictScore: s.strictScore,
    };
  });
}

export function groupPairs(
  pairs: PairRun[],
  keyOf: (p: PairRun) => string | string[] | undefined,
): Map<string, PostureSummary> {
  const buckets = new Map<string, PairRun[]>();
  for (const p of pairs) {
    const k = keyOf(p);
    if (k === undefined) continue;
    for (const key of new Set(Array.isArray(k) ? k : [k])) {
      const b = buckets.get(key);
      if (b) b.push(p);
      else buckets.set(key, [p]);
    }
  }
  const out = new Map<string, PostureSummary>();
  for (const [key, ps] of buckets) out.set(key, summarizePairs(ps));
  return out;
}
