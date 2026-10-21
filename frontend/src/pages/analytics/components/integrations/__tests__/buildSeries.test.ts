import { describe, it, expect } from 'vitest';
import { buildSeries, intervalForWindow } from '../buildSeries';

const short = { from: '2026-10-01T00:00:00Z', to: '2026-10-31T00:00:00Z' };
const long = { from: '2026-06-01T00:00:00Z', to: '2026-10-31T00:00:00Z' };

describe('intervalForWindow', () => {
  it('is day up to 90 days and week beyond', () => {
    expect(intervalForWindow(short)).toBe('day');
    expect(intervalForWindow({ from: '2026-01-01T00:00:00Z', to: '2026-04-01T00:00:00Z' })).toBe('day'); // 90d
    expect(intervalForWindow(long)).toBe('week');
  });
});

describe('buildSeries', () => {
  it('splits alerts into linked and organic (count - linked)', () => {
    const out = buildSeries([], [{ date: '2026-10-02', count: 10, linked: 4, interval: 'day' }], short);
    expect(out).toEqual([{ date: '2026-10-02', tests: 0, linked: 4, organic: 6 }]);
  });

  it('clamps organic at zero when linked exceeds count', () => {
    const out = buildSeries([], [{ date: '2026-10-02', count: 2, linked: 5, interval: 'day' }], short);
    expect(out[0].organic).toBe(0);
  });

  it('merges executions and alerts on shared dates, sorted', () => {
    const out = buildSeries(
      [{ timestamp: '2026-10-03T00:00:00Z', total: 7 }, { timestamp: '2026-10-02T00:00:00Z', total: 1 }],
      [{ date: '2026-10-03T00:00:00Z', count: 3, linked: 1, interval: 'day' }, { date: '2026-10-05', count: 1, linked: 0, interval: 'day' }],
      short,
    );
    expect(out).toEqual([
      { date: '2026-10-02', tests: 1, linked: 0, organic: 0 },
      { date: '2026-10-03', tests: 7, linked: 1, organic: 2 },
      { date: '2026-10-05', tests: 0, linked: 0, organic: 1 },
    ]);
  });

  it('buckets executions into Monday weeks on long windows, even with no alerts', () => {
    const out = buildSeries(
      [{ timestamp: '2026-10-19T00:00:00Z', total: 2 }, { timestamp: '2026-10-21T00:00:00Z', total: 3 }],
      [],
      long,
    );
    expect(out).toEqual([{ date: '2026-10-19', tests: 5, linked: 0, organic: 0 }]);
  });
});
