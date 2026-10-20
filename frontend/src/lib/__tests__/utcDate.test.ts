process.env.TZ = 'America/Santo_Domingo';

import { describe, it, expect } from 'vitest';
import { utcDayKey, formatUtcDay } from '../utcDate';

describe('utcDate (TZ=America/Santo_Domingo)', () => {
  it('formatUtcDay formats the UTC day, not the local one', () => {
    expect(formatUtcDay('2026-10-13T00:00:00.000Z')).toBe('Oct 13');
    expect(formatUtcDay('2026-10-13T00:00:00.000Z', 'long')).toBe('Oct 13, 2026');
  });
  it('utcDayKey handles ISO, day-end, and numeric epoch-ms strings', () => {
    expect(utcDayKey('2026-10-13T23:59:59.999Z')).toBe('2026-10-13');
    expect(utcDayKey('1760313600000')).toBe('2025-10-13');
    expect(utcDayKey(1760313600000)).toBe('2025-10-13');
  });
});
