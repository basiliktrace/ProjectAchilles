import { describe, it, expect } from 'vitest';
import { isoWeekStart, bucketExecutions } from '../weeklyBuckets';

describe('isoWeekStart', () => {
  it('returns the Monday of the week (UTC)', () => {
    expect(isoWeekStart('2026-10-21')).toBe('2026-10-19'); // Wed
    expect(isoWeekStart('2026-10-19')).toBe('2026-10-19'); // Mon
    expect(isoWeekStart('2026-10-25T23:00:00Z')).toBe('2026-10-19'); // Sun
  });
});

describe('bucketExecutions', () => {
  const pts = [
    { timestamp: '2026-10-19T00:00:00Z', total: 2 },
    { timestamp: '2026-10-21T00:00:00Z', total: 3 },
    { timestamp: '2026-10-26T00:00:00Z', total: 4 },
  ];
  it('keeps daily points keyed by date for day interval', () => {
    expect(bucketExecutions(pts, 'day')).toEqual({
      '2026-10-19': 2,
      '2026-10-21': 3,
      '2026-10-26': 4,
    });
  });
  it('sums daily points into ISO weeks for week interval', () => {
    expect(bucketExecutions(pts, 'week')).toEqual({ '2026-10-19': 5, '2026-10-26': 4 });
  });
});
