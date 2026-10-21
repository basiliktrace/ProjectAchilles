import { beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_TIME_FROM,
  DEFAULT_TIME_RANGE,
  readStoredTimeRange,
  resolveTimeRange,
  resolveTimeWindow,
  timeRangeLabel,
  storeTimeRange,
  timeRangeButtonLabel,
  timeRangeDays,
  timeRangeFromParams,
  timeRangeToParams,
} from '../timeRange';

const CUSTOM = { preset: 'custom', from: '2026-10-01T00:00:00.000Z', to: '2026-10-11T00:00:00.000Z' };

beforeEach(() => sessionStorage.clear());

describe('timeRange', () => {
  it('defaults to 30d on both pages', () => {
    expect(DEFAULT_TIME_RANGE).toEqual({ preset: '30d' });
  });

  it('reads presets and custom ranges from URL params', () => {
    expect(timeRangeFromParams(new URLSearchParams('date=7d'))).toEqual({ preset: '7d' });
    expect(timeRangeFromParams(new URLSearchParams('date=all'))).toEqual({ preset: 'all' });
    expect(timeRangeFromParams(new URLSearchParams(`from=${CUSTOM.from}&to=${CUSTOM.to}`))).toEqual(CUSTOM);
  });

  it('rejects missing, unknown or half-specified ranges', () => {
    expect(timeRangeFromParams(new URLSearchParams(''))).toBeNull();
    expect(timeRangeFromParams(new URLSearchParams('date=365d'))).toBeNull();
    expect(timeRangeFromParams(new URLSearchParams(`from=${CUSTOM.from}`))).toBeNull();
    expect(timeRangeFromParams(new URLSearchParams('from=yesterday&to=today'))).toBeNull();
  });

  it("reads the Dashboard's legacy range= param only when asked", () => {
    expect(timeRangeFromParams(new URLSearchParams('range=90d'), 'range')).toEqual({ preset: '90d' });
    expect(timeRangeFromParams(new URLSearchParams('range=90d'))).toBeNull();
    expect(timeRangeFromParams(new URLSearchParams('date=7d&range=90d'), 'range')).toEqual({ preset: '7d' });
  });

  it('omits the default from URLs and round-trips the rest', () => {
    expect(timeRangeToParams({ preset: '30d' })).toEqual({});
    for (const value of [{ preset: '1d' }, { preset: '90d' }, { preset: 'all' }, CUSTOM]) {
      expect(timeRangeFromParams(new URLSearchParams(timeRangeToParams(value)))).toEqual(value);
    }
  });

  it('remembers a range for the tab session', () => {
    expect(readStoredTimeRange()).toBeNull();
    storeTimeRange({ preset: '7d' });
    expect(readStoredTimeRange()).toEqual({ preset: '7d' });
    storeTimeRange(CUSTOM);
    expect(readStoredTimeRange()).toEqual(CUSTOM);
  });

  it('ignores corrupt or invalid stored values', () => {
    sessionStorage.setItem('achilles.timeRange', '{not json');
    expect(readStoredTimeRange()).toBeNull();
    sessionStorage.setItem('achilles.timeRange', JSON.stringify({ preset: '14d' }));
    expect(readStoredTimeRange()).toBeNull();
  });

  it('resolves URL first, then the remembered range, then the default', () => {
    expect(resolveTimeRange(new URLSearchParams(''))).toEqual(DEFAULT_TIME_RANGE);
    storeTimeRange({ preset: 'all' });
    expect(resolveTimeRange(new URLSearchParams(''))).toEqual({ preset: 'all' });
    expect(resolveTimeRange(new URLSearchParams('date=7d'))).toEqual({ preset: '7d' });
  });

  it('converts ranges to trend day counts within 1-365', () => {
    expect(timeRangeDays({ preset: '1d' })).toBe(1);
    expect(timeRangeDays({ preset: '30d' })).toBe(30);
    expect(timeRangeDays({ preset: 'all' })).toBe(365);
    expect(timeRangeDays(CUSTOM)).toBe(10);
    expect(timeRangeDays({ preset: 'custom', from: CUSTOM.to, to: CUSTOM.from })).toBe(1);
  });

  it('labels the preset buttons', () => {
    expect(['1d', '7d', '30d', '90d', 'all'].map(timeRangeButtonLabel)).toEqual(['24h', '7d', '30d', '90d', 'All']);
  });
});

describe('resolveTimeWindow', () => {
  const now = new Date('2026-10-20T12:00:00.000Z');

  it('maps all to ALL_TIME_FROM with allTime and to 90 days without', () => {
    expect(resolveTimeWindow({ preset: 'all' }, { allTime: true, now })).toEqual({
      from: ALL_TIME_FROM,
      to: now.toISOString(),
    });
    expect(resolveTimeWindow({ preset: 'all' }, { now })).toEqual({
      from: new Date(now.getTime() - 90 * 86_400_000).toISOString(),
      to: now.toISOString(),
    });
  });

  it('resolves a relative preset against now', () => {
    expect(resolveTimeWindow({ preset: '7d' }, { now })?.from).toBe('2026-10-13T12:00:00.000Z');
  });

  it('extends a date-only custom to-bound to end of day', () => {
    const w = resolveTimeWindow({ preset: 'custom', from: '2026-10-01', to: '2026-10-05' }, { now });
    expect(w).not.toBeNull();
    const to = new Date(w!.to);
    expect(to.getHours()).toBe(23);
    expect(to.getMinutes()).toBe(59);
  });

  it('returns null for from >= to', () => {
    expect(
      resolveTimeWindow({ preset: 'custom', from: '2026-10-05T00:00:00Z', to: '2026-10-01T00:00:00Z' }, { now }),
    ).toBeNull();
  });
});

describe('timeRangeLabel', () => {
  it('describes presets, all time and custom ranges', () => {
    expect(timeRangeLabel({ preset: '30d' })).toBe('last 30 days');
    expect(timeRangeLabel({ preset: '1d' })).toBe('last 24 hours');
    expect(timeRangeLabel({ preset: 'all' })).toBe('all time');
    expect(timeRangeLabel(CUSTOM)).toBe('selected range');
  });
});
