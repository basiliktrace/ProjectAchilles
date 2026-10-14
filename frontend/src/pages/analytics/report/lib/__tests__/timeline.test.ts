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

/** Local wall-clock fields of an instant in a zone (test-side oracle, independent of timeline.ts). */
const wall = (t: number, tz: string) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
    }).formatToParts(new Date(t)).map((x) => [x.type, x.value]),
  );
  return { month: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second) };
};

describe('DST: each tick sits on its own local date', () => {
  it('New York day axis moves midnight from 05:00Z to 04:00Z across spring-forward', () => {
    expect(axisTicks('2026-03-07T00:00:00.000Z', '2026-03-10T00:00:00.000Z', 'day', 'America/New_York')).toEqual([
      { t: Date.parse('2026-03-07T05:00:00.000Z'), label: '7 Mar' },
      { t: Date.parse('2026-03-08T05:00:00.000Z'), label: '8 Mar' },
      { t: Date.parse('2026-03-09T04:00:00.000Z'), label: '9 Mar' },
    ]);
  });

  it('New York day axis moves midnight from 04:00Z to 05:00Z across fall-back', () => {
    expect(axisTicks('2026-10-30T00:00:00.000Z', '2026-11-03T00:00:00.000Z', 'day', 'America/New_York')).toEqual([
      { t: Date.parse('2026-10-30T04:00:00.000Z'), label: '30 Oct' },
      { t: Date.parse('2026-10-31T04:00:00.000Z'), label: '31 Oct' },
      { t: Date.parse('2026-11-01T04:00:00.000Z'), label: '1 Nov' },
      { t: Date.parse('2026-11-02T05:00:00.000Z'), label: '2 Nov' },
    ]);
  });

  it('New York hour axis labels 1 Nov exactly once, at its local midnight', () => {
    const ticks = axisTicks('2026-10-31T12:00:00.000Z', '2026-11-01T12:00:00.000Z', 'hour', 'America/New_York');
    expect(ticks.filter((t) => t.label === '1 Nov')).toEqual([{ t: Date.parse('2026-11-01T04:00:00.000Z'), label: '1 Nov' }]);
  });

  it('Santiago day axis across a midnight spring-forward labels 5 to 9 Sep once each', () => {
    const ticks = axisTicks('2026-09-04T12:00:00.000Z', '2026-09-09T12:00:00.000Z', 'day', 'America/Santiago');
    expect(ticks.map((t) => t.label)).toEqual(['5 Sep', '6 Sep', '7 Sep', '8 Sep', '9 Sep']);
    // 00:00 on 6 Sep does not exist; the tick is the first instant of that date (01:00 local).
    expect(ticks[1]).toEqual({ t: Date.parse('2026-09-06T04:00:00.000Z'), label: '6 Sep' });
    expect(wall(ticks[1].t, 'America/Santiago')).toMatchObject({ month: 9, day: 6 });
  });

  it('Santiago hour axis keeps the 6 Sep date label across the same gap', () => {
    const ticks = axisTicks('2026-09-05T12:00:00.000Z', '2026-09-06T12:00:00.000Z', 'hour', 'America/Santiago');
    expect(ticks.filter((t) => t.label === '6 Sep')).toEqual([{ t: Date.parse('2026-09-06T04:00:00.000Z'), label: '6 Sep' }]);
  });

  it('Lord_Howe day axis puts every tick at local 00:00 across its 30-minute change', () => {
    const zone = 'Australia/Lord_Howe';
    const ticks = axisTicks('2026-09-30T00:00:00.000Z', '2026-10-08T00:00:00.000Z', 'day', zone);
    expect(ticks.map((t) => t.label)).toEqual(['1 Oct', '2 Oct', '3 Oct', '4 Oct', '5 Oct', '6 Oct', '7 Oct', '8 Oct']);
    for (const { t } of ticks) expect(wall(t, zone)).toMatchObject({ hour: 0, minute: 0, second: 0 });
    expect(ticks[3]).toEqual({ t: Date.parse('2026-10-03T13:30:00.000Z'), label: '4 Oct' });
    expect(ticks[4]).toEqual({ t: Date.parse('2026-10-04T13:00:00.000Z'), label: '5 Oct' });
  });

  it('Lord_Howe hour axis labels only whole local hours across its 30-minute change', () => {
    const zone = 'Australia/Lord_Howe';
    const ticks = axisTicks('2026-10-03T12:00:00.000Z', '2026-10-04T12:00:00.000Z', 'hour', zone);
    for (const { t } of ticks) expect(wall(t, zone).minute).toBe(0);
    expect(ticks.map((t) => t.label)).toEqual(['4 Oct', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00']);
    expect(ticks[1]).toEqual({ t: Date.parse('2026-10-03T16:00:00.000Z'), label: '03:00' });
  });
});
