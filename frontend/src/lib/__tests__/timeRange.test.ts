import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TIME_RANGE,
  readStoredTimeRange,
  resolveTimeRange,
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
