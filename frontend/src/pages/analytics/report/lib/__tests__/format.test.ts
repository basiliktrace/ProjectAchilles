import { describe, it, expect } from 'vitest';
import { fmtCount, fmtDate, fmtDateTime, fmtDuration, fmtLatency, fmtPct, fmtShortDate, fmtTime, plural, truncate } from '../format';

const T = '2026-10-12T12:47:49.000Z';

describe('format', () => {
  it('formats dates and times in the given zone', () => {
    expect(fmtDate(T, 'UTC')).toBe('12 Oct 2026');
    expect(fmtShortDate(T, 'UTC')).toBe('12 Oct');
    expect(fmtTime(T, 'UTC')).toBe('12:47');
    expect(fmtTime(T, 'UTC', true)).toBe('12:47:49');
    expect(fmtTime(T, 'America/Santo_Domingo')).toBe('08:47');
    expect(fmtDateTime(T, 'UTC')).toBe('12 Oct 2026, 12:47');
  });

  it('formats percentages, counts and latencies', () => {
    expect(fmtPct(0.561)).toBe('56%');
    expect(fmtPct(null)).toBe('—');
    expect(fmtCount(12345)).toBe('12,345');
    expect(fmtCount(12345, true)).toBe('about 12,345');
    expect(fmtLatency(62)).toBe('+1m 02s');
    expect(fmtLatency(-45)).toBe('−45s');
    expect(fmtLatency(7500)).toBe('+2h 05m');
    expect(fmtDuration(403_000)).toBe('6m 43s');
  });

  it('never rounds a partial rate to 0% or 100%', () => {
    expect(fmtPct(0.995)).toBe('99%');
    expect(fmtPct(0.9951)).toBe('99%');
    expect(fmtPct(0.0049)).toBe('1%');
    expect(fmtPct(0)).toBe('0%');
    expect(fmtPct(1)).toBe('100%');
    expect(fmtPct(0.5)).toBe('50%');
  });

  it('truncates, so a printed rate never overstates protection or disagrees with its band', () => {
    // 0.7496 is Partial (below 0.75) and a finding; rounding would print "75%" beside it.
    expect(fmtPct(0.7496)).toBe('74%');
    expect(fmtPct(0.3999)).toBe('39%');
    expect(fmtPct(6 / 9)).toBe('66%');
    expect(fmtPct(0.75)).toBe('75%');
    expect(fmtPct(0.4)).toBe('40%');
  });

  it('is not thrown off by binary floating point at whole percentages', () => {
    // 0.29 * 100 is 28.999999999999996 in floating point.
    expect(fmtPct(0.29)).toBe('29%');
    expect(fmtPct(0.57)).toBe('57%');
    expect(fmtPct(29 / 100)).toBe('29%');
  });

  it('pluralizes and truncates', () => {
    expect(plural(1, 'run')).toBe('1 run');
    expect(plural(1504, 'run')).toBe('1,504 runs');
    expect(truncate('LockBit 3.0 Double Extortion Kill Chain', 20)).toBe('LockBit 3.0 Double…');
    expect(truncate('short', 20)).toBe('short');
  });
});
