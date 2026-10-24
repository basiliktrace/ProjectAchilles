import { describe, it, expect } from 'vitest';
import {
  randomWindowBoundsForDate,
  randomWindowForDate,
  randomTimeForDate,
  todayInTimezone,
} from '../scheduleTime.js';

describe('scheduleTime', () => {
  it('weekday bounds are 9-17', () => {
    expect(randomWindowBoundsForDate('2026-10-21', 'UTC')).toEqual({ startHour: 9, endHour: 17 });
  });

  it('weekend bounds are 0-24', () => {
    expect(randomWindowBoundsForDate('2026-10-24', 'UTC')).toEqual({ startHour: 0, endHour: 24 });
  });

  it('randomWindowForDate returns UTC instants for a weekday', () => {
    const { start, end } = randomWindowForDate('2026-10-21', 'America/Santo_Domingo');
    expect(start.toISOString()).toBe('2026-10-21T13:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-21T21:00:00.000Z');
  });

  it('weekend window ends at next-day local midnight', () => {
    const { start, end } = randomWindowForDate('2026-10-24', 'UTC');
    expect(start.toISOString()).toBe('2026-10-24T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-25T00:00:00.000Z');
  });

  it('randomTimeForDate stays within office hours on a weekday', () => {
    for (let i = 0; i < 200; i++) {
      const t = randomTimeForDate('2026-10-21', 'UTC');
      expect(t >= '09:00' && t <= '16:59').toBe(true);
    }
  });

  it('todayInTimezone formats YYYY-MM-DD in the zone', () => {
    expect(todayInTimezone('Asia/Tokyo', new Date('2026-10-21T20:00:00Z'))).toBe('2026-10-22');
  });
});
