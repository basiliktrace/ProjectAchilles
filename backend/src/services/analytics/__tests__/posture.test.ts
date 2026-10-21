import { describe, it, expect } from 'vitest';
import {
  resolvePostureWindow,
  latestPairsAsOf,
  applyOutcomeFilters,
  summarizePairs,
  postureSeries,
  groupPairs,
} from '../posture.js';
import type { PairRun, PostureWindow } from '../posture.js';

const DAY = 86_400_000;

function run(over: Partial<PairRun> = {}): PairRun {
  return {
    pairKey: 'A',
    ts: 0,
    protected: false,
    strictProtected: false,
    errorCodes: [101],
    errorNames: [],
    hostname: 'host',
    testName: 'test',
    techniques: [],
    ...over,
  };
}

describe('latestPairsAsOf', () => {
  it("keeps only each pair's newest run <= asOf", () => {
    const runs = [
      run({ ts: 2000, protected: true }),
      run({ ts: 1000, protected: false }),
    ];
    const out = latestPairsAsOf(runs, 5000, 10_000);
    expect(out).toHaveLength(1);
    expect(out[0].ts).toBe(2000);
  });

  it('drops a pair whose newest run is older than asOf - freshness, keeps one exactly at the bound', () => {
    const asOf = 10 * DAY;
    const fresh = 3 * DAY;
    expect(latestPairsAsOf([run({ ts: asOf - fresh - 1 })], asOf, fresh)).toEqual([]);
    expect(latestPairsAsOf([run({ ts: asOf - fresh })], asOf, fresh)).toHaveLength(1);
  });

  it('ignores runs after asOf', () => {
    const runs = [run({ ts: 1000 }), run({ ts: 9000, protected: true })];
    const out = latestPairsAsOf(runs, 5000, 10_000);
    expect(out).toHaveLength(1);
    expect(out[0].ts).toBe(1000);
  });
});

describe('summarizePairs', () => {
  it('empty -> score null, strictScore null, pairCount 0', () => {
    expect(summarizePairs([])).toEqual({
      pairCount: 0,
      protectedCount: 0,
      strictProtectedCount: 0,
      score: null,
      strictScore: null,
    });
  });

  it('rounds to 2 decimals', () => {
    const s = summarizePairs([
      run({ pairKey: 'a', protected: true, strictProtected: true }),
      run({ pairKey: 'b', protected: true }),
      run({ pairKey: 'c' }),
    ]);
    expect(s.score).toBe(66.67);
    expect(s.strictScore).toBe(33.33);
    expect(s.protectedCount).toBe(2);
    expect(s.strictProtectedCount).toBe(1);
  });
});

describe('applyOutcomeFilters', () => {
  const pairs = [
    run({ pairKey: 'u', errorCodes: [101], errorNames: ['Unprotected'] }),
    run({ pairKey: 'p105', protected: true, strictProtected: true, errorCodes: [105], errorNames: ['FileQuarantinedOnExtraction'] }),
    run({ pairKey: 'p126', protected: true, strictProtected: true, errorCodes: [126], errorNames: ['ExecutionPrevented'] }),
    run({ pairKey: 'p127', protected: true, strictProtected: true, errorCodes: [127], errorNames: ['Quarantined'] }),
  ];
  const keys = (ps: PairRun[]) => ps.map((p) => p.pairKey);

  it('all / undefined keep everything', () => {
    expect(applyOutcomeFilters(pairs, {})).toHaveLength(4);
    expect(applyOutcomeFilters(pairs, { result: 'all' })).toHaveLength(4);
  });
  it('result=unprotected keeps pairs whose combined verdict is unprotected', () => {
    expect(keys(applyOutcomeFilters(pairs, { result: 'unprotected' }))).toEqual(['u']);
  });
  it('result=protected keeps pairs whose combined verdict is protected', () => {
    expect(keys(applyOutcomeFilters(pairs, { result: 'protected' }))).toEqual(['p105', 'p126', 'p127']);
  });
  it('result follows the combined verdict, not the codes: a detected 101 counts as protected', () => {
    const detected = [run({ pairKey: 'd', protected: true, strictProtected: false, errorCodes: [101], errorNames: ['Unprotected'] })];
    expect(keys(applyOutcomeFilters(detected, { result: 'protected' }))).toEqual(['d']);
    expect(applyOutcomeFilters(detected, { result: 'unprotected' })).toEqual([]);
  });
  it('an any-stage bundle pair with mixed control codes matches exactly one of protected / unprotected', () => {
    const bundles = [
      run({ pairKey: 'bp', protected: true, strictProtected: true, errorCodes: [101, 126] }),
      run({ pairKey: 'bu', protected: false, strictProtected: false, errorCodes: [101, 126] }),
    ];
    expect(keys(applyOutcomeFilters(bundles, { result: 'protected' }))).toEqual(['bp']);
    expect(keys(applyOutcomeFilters(bundles, { result: 'unprotected' }))).toEqual(['bu']);
  });
  it('result=inconclusive -> []', () => {
    expect(applyOutcomeFilters(pairs, { result: 'inconclusive' })).toEqual([]);
  });
  it('errorCodes keeps only matching pairs', () => {
    expect(keys(applyOutcomeFilters(pairs, { errorCodes: [126] }))).toEqual(['p126']);
  });
  it('errorCodes stays code-based: matches any code of a mixed bundle run', () => {
    const bundle = [run({ pairKey: 'b', protected: false, errorCodes: [101, 126] })];
    expect(keys(applyOutcomeFilters(bundle, { errorCodes: [126] }))).toEqual(['b']);
  });
  it('errorNames keeps only matching pairs', () => {
    expect(keys(applyOutcomeFilters(pairs, { errorNames: ['Quarantined'] }))).toEqual(['p127']);
  });
});

describe('resolvePostureWindow', () => {
  const now = Date.parse('2026-10-20T19:20:00Z');

  it('now-7d', () => {
    const w = resolvePostureWindow('now-7d', undefined, now);
    expect(w.freshnessMs).toBe(7 * DAY);
    expect(w.toMs).toBe(now);
    expect(w.fromMs).toBe(now - 7 * DAY);
    expect(w.step).toBe('day');
    expect(w.label).toBe('7d');
  });

  it('ISO from/to', () => {
    const from = '2026-10-01T00:00:00Z';
    const to = '2026-10-10T12:00:00Z';
    const w = resolvePostureWindow(from, to, now);
    expect(w.freshnessMs).toBe(Date.parse(to) - Date.parse(from));
    expect(w.toMs).toBe(Date.parse(to));
    expect(w.fromMs).toBe(Date.parse(from));
  });

  it('caps at 365 days', () => {
    const w = resolvePostureWindow('2000-01-01T00:00:00Z', undefined, now);
    expect(w.freshnessMs).toBe(365 * DAY);
    expect(w.label).toBe('last 365d');
    expect(w.step).toBe('week');
  });

  it('>90d uses weekly step', () => {
    expect(resolvePostureWindow('now-180d', undefined, now).step).toBe('week');
  });

  it('defaults to 7d when from is missing', () => {
    expect(resolvePostureWindow(undefined, undefined, now).freshnessMs).toBe(7 * DAY);
  });
});

describe('postureSeries', () => {
  const now = Date.parse('2026-10-20T19:20:00Z');
  const noFilter = {};

  function makeRuns(n: number, spanMs: number, toMs: number): PairRun[] {
    const runs: PairRun[] = [];
    for (let i = 0; i < n; i++) {
      const p = i % 3 !== 0;
      runs.push(
        run({
          pairKey: `p${i % 5000}`,
          ts: toMs - Math.floor(((i * 7919) % 1000) / 1000 * spanMs),
          protected: p,
          strictProtected: i % 2 === 0,
          errorCodes: [p ? 126 : 101],
        }),
      );
    }
    return runs;
  }

  it('last point equals summarizePairs(latestPairsAsOf(...))', () => {
    const w = resolvePostureWindow('now-30d', undefined, now);
    const runs = makeRuns(2000, 60 * DAY, now);
    const series = postureSeries(runs, w, noFilter);
    const last = series[series.length - 1];
    const s = summarizePairs(latestPairsAsOf(runs, w.toMs, w.freshnessMs));
    expect(last.score).toBe(s.score);
    expect(last.total).toBe(s.pairCount);
    expect(last.protected).toBe(s.protectedCount);
    expect(last.strictScore).toBe(s.strictScore);
  });

  it('last point timestamp is toMs', () => {
    const w = resolvePostureWindow('now-7d', undefined, now);
    const series = postureSeries([run({ ts: now - DAY })], w, noFilter);
    expect(series[series.length - 1].timestamp).toBe('2026-10-20T19:20:00.000Z');
  });

  it('daily points are UTC day ends', () => {
    const w = resolvePostureWindow('now-7d', undefined, now);
    const series = postureSeries([], w, noFilter);
    expect(series).toHaveLength(8);
    expect(series[0].timestamp).toBe('2026-10-13T23:59:59.999Z');
    expect(series[6].timestamp).toBe('2026-10-19T23:59:59.999Z');
    expect(series[7].timestamp).toBe('2026-10-20T19:20:00.000Z');
  });

  it('weekly points step back 7 days from toMs', () => {
    const w = resolvePostureWindow('now-180d', undefined, now);
    const series = postureSeries([], w, noFilter);
    expect(series[series.length - 1].timestamp).toBe('2026-10-20T19:20:00.000Z');
    expect(series[series.length - 2].timestamp).toBe('2026-10-13T23:59:59.999Z');
    expect(series[series.length - 3].timestamp).toBe('2026-10-06T23:59:59.999Z');
    expect(series.length).toBeLessThan(30);
  });

  it('carries a pair forward through a testing pause, then expires it', () => {
    const day0 = Date.parse('2026-10-10T00:00:00Z');
    const dayEnd0 = day0 + DAY - 1; // 23:59:59.999Z
    const w: PostureWindow = {
      fromMs: day0,
      toMs: day0 + 9 * DAY + 3_600_000,
      freshnessMs: 3 * DAY,
      step: 'day',
      label: '3d',
    };
    const series = postureSeries(
      [run({ ts: dayEnd0, protected: true, strictProtected: true, errorCodes: [126] })],
      w,
      noFilter,
    );
    expect(series.length).toBeGreaterThan(5);
    for (let i = 0; i <= 3; i++) expect(series[i].score).toBe(100);
    for (let i = 4; i < series.length; i++) expect(series[i].score).toBeNull();
  });

  it('applies outcome filters per point', () => {
    const w = resolvePostureWindow('now-7d', undefined, now);
    const runs = [
      run({ pairKey: 'a', ts: now - 2 * DAY, protected: true, errorCodes: [126] }),
      run({ pairKey: 'b', ts: now - 2 * DAY, protected: false, errorCodes: [101] }),
    ];
    const all = postureSeries(runs, w, noFilter);
    const unp = postureSeries(runs, w, { result: 'unprotected' });
    const last = all.length - 1;
    expect(all[last].total).toBe(2);
    expect(all[last].score).toBe(50);
    expect(unp[last].total).toBe(1);
    expect(unp[last].score).toBe(0);
  });

  it('100k runs x 91 points completes < 1000 ms', () => {
    const w = resolvePostureWindow('now-90d', undefined, now);
    const runs = makeRuns(100_000, 90 * DAY, now);
    const t0 = performance.now();
    const series = postureSeries(runs, w, noFilter);
    const elapsed = performance.now() - t0;
    expect(series).toHaveLength(91);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('groupPairs', () => {
  it('array keys count a pair under each technique; undefined skipped', () => {
    const pairs = [
      run({ pairKey: 'a', protected: true, techniques: ['T1', 'T2'] }),
      run({ pairKey: 'b', protected: false, techniques: ['T1'] }),
      run({ pairKey: 'c', techniques: [] }),
    ];
    const g = groupPairs(pairs, (p) => (p.techniques.length ? p.techniques : undefined));
    expect(g.size).toBe(2);
    expect(g.get('T1')?.pairCount).toBe(2);
    expect(g.get('T1')?.score).toBe(50);
    expect(g.get('T2')?.pairCount).toBe(1);
    expect(g.get('T2')?.score).toBe(100);
  });

  it('groups by threatActor; pairs without one are skipped', () => {
    const pairs = [
      run({ pairKey: 'a', protected: true, threatActor: 'APT29' }),
      run({ pairKey: 'b', threatActor: 'APT29' }),
      run({ pairKey: 'c', protected: true, threatActor: 'Lazarus' }),
      run({ pairKey: 'd' }),
    ];
    const g = groupPairs(pairs, (p) => p.threatActor);
    expect([...g.keys()].sort()).toEqual(['APT29', 'Lazarus']);
    expect(g.get('APT29')).toMatchObject({ pairCount: 2, protectedCount: 1, score: 50 });
    expect(g.get('Lazarus')).toMatchObject({ pairCount: 1, protectedCount: 1, score: 100 });
  });
});
