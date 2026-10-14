import { describe, it, expect } from 'vitest';
import { axisTicks, canUseGlyphs, coverageNote, halvesTrend, packPositions, timeScale, trendPoints } from '../timeline';
import { counts, makeWindow } from '../../__tests__/fixtures';
import type { ReportTimelineBucket } from '@/services/api/reports';

const HOUR = 3_600_000;
const DAY = 86_400_000;

describe('packPositions', () => {
  it('keeps order and enforces a minimum gap', () => {
    expect(packPositions([30, 10, 12], 10)).toEqual([30, 10, 20]);
  });
});

describe('canUseGlyphs (spec §5.5 rule 6)', () => {
  const plot = (from: number, to: number) => timeScale(new Date(from).toISOString(), new Date(to).toISOString(), 0, 516);
  const start = Date.parse('2026-10-12T00:00:00Z');

  it('uses glyphs for a 12-run one-day drill', () => {
    const x = plot(start, start + DAY);
    const xs = Array.from({ length: 12 }, (_, i) => x(start + i * 2 * HOUR));
    expect(canUseGlyphs([xs], true)).toBe(true);
  });

  it('uses buckets for a year of daily runs', () => {
    const x = plot(start, start + 365 * DAY);
    const xs = Array.from({ length: 365 }, (_, i) => x(start + i * DAY));
    expect(canUseGlyphs([xs], true)).toBe(false);
  });

  it('uses buckets for a 20-run burst inside a 90-day window', () => {
    const x = plot(start, start + 90 * DAY);
    const xs = Array.from({ length: 20 }, (_, i) => x(start + 45 * DAY + i * 30_000));
    expect(canUseGlyphs([xs], true)).toBe(false);
  });

  it('never uses glyphs when the runs list is truncated', () => {
    expect(canUseGlyphs([[10, 100]], false)).toBe(false);
  });
});

describe('axisTicks', () => {
  it('ticks every 3 hours on a one-day axis, dating midnight', () => {
    const ticks = axisTicks('2026-10-12T00:00:00.000Z', '2026-10-13T00:00:00.000Z', 'hour', 'UTC');
    expect(ticks.map((t) => t.label)).toEqual(['12 Oct', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00', '13 Oct']);
  });

  it('honors the time zone', () => {
    const ticks = axisTicks('2026-10-12T04:00:00.000Z', '2026-10-12T10:00:00.000Z', 'hour', 'America/Santo_Domingo');
    expect(ticks[0]).toEqual({ t: Date.parse('2026-10-12T04:00:00.000Z'), label: '12 Oct' });
  });

  it('ticks Mondays on a day axis', () => {
    const labels = axisTicks('2026-09-13T23:40:00.000Z', '2026-10-13T23:40:00.000Z', 'day', 'UTC').map((t) => t.label);
    expect(labels).toEqual(['14 Sep', '21 Sep', '28 Sep', '5 Oct', '12 Oct']);
  });

  it('falls back to every midnight when a short day axis has under two Mondays', () => {
    expect(axisTicks('2026-10-13T00:00:00.000Z', '2026-10-16T00:00:00.000Z', 'day', 'UTC')).toHaveLength(4);
  });

  it('ticks months on a week axis and quarters on a month axis', () => {
    expect(axisTicks('2026-01-15T00:00:00.000Z', '2026-05-15T00:00:00.000Z', 'week', 'UTC').map((t) => t.label)).toEqual(['Feb', 'Mar', 'Apr', 'May']);
    expect(axisTicks('2025-01-15T00:00:00.000Z', '2026-10-15T00:00:00.000Z', 'month', 'UTC').map((t) => t.label))
      .toEqual(['Apr 2025', 'Jul 2025', 'Oct 2025', 'Jan 2026', 'Apr 2026', 'Jul 2026', 'Oct 2026']);
  });
});

const bucket = (start: string, c: Parameters<typeof counts>[0]): ReportTimelineBucket => ({ start, lanes: [{ testKey: 'b', runs: 1, outcomes: counts(c) }] });

describe('trendPoints', () => {
  it('skips buckets under 5 conclusive results', () => {
    const points = trendPoints([bucket('2026-10-11T00:00:00.000Z', { protected: 3 }), bucket('2026-10-12T00:00:00.000Z', { protected: 3, unprotected: 3 })]);
    expect(points).toEqual([{ t: Date.parse('2026-10-12T00:00:00.000Z'), rate: 0.5 }]);
  });
});

describe('halvesTrend', () => {
  it('compares the first and second half when both have 10 results', () => {
    const buckets = [bucket('2026-10-01T00:00:00.000Z', { protected: 4, unprotected: 6 }), bucket('2026-10-20T00:00:00.000Z', { protected: 8, unprotected: 2 })];
    expect(halvesTrend(buckets, '2026-09-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z')).toEqual({ first: 0.4, second: 0.8 });
    expect(halvesTrend(buckets.slice(0, 1), '2026-09-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z')).toBeNull();
  });
});

describe('coverageNote', () => {
  it('appears when executions cover under a quarter of the axis', () => {
    expect(coverageNote(makeWindow(), 'UTC')).toBe('Executions only between 11 Oct 2026, 09:12 and 12 Oct 2026, 12:47.');
    expect(coverageNote(makeWindow({ firstExecution: '2026-09-15T00:00:00.000Z' }), 'UTC')).toBeNull();
  });
});
