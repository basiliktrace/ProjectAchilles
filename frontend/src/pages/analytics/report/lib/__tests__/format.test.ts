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

  it('pluralizes and truncates', () => {
    expect(plural(1, 'run')).toBe('1 run');
    expect(plural(1504, 'run')).toBe('1,504 runs');
    expect(truncate('LockBit 3.0 Double Extortion Kill Chain', 20)).toBe('LockBit 3.0 Double…');
    expect(truncate('short', 20)).toBe('short');
  });
});
