import { describe, it, expect } from 'vitest';
import { runTag, computeRunRelease, computeDayRelease, formatDual } from '../window.js';
import type { PreExecutionNoticeSettings } from '../../../types/integrations.js';

const s = (o: Partial<PreExecutionNoticeSettings> = {}): PreExecutionNoticeSettings => ({
  enabled: true, recipients: ['a@b.c'], lead_minutes: 5, max_wait_minutes: 60,
  pickup_window_minutes: 120, send_finished: true, ...o,
});
const t0 = new Date('2026-10-23T13:00:00.000Z');
const min = (n: number) => new Date(t0.getTime() + n * 60_000);

describe('window', () => {
  it('runTag', () => {
    expect(runTag('7f3c9a12-1111-2222-3333-444444444444')).toBe('PA-RUN-7f3c9a');
  });
  it('computeRunRelease', () => {
    const r = computeRunRelease(t0, s(), 300);
    expect(r.releaseAt).toEqual(min(5));
    expect(r.pickupDeadline).toEqual(min(125));
    expect(r.windowEnd).toEqual(min(130));
  });
  it('lead 0 releases immediately', () => {
    expect(computeRunRelease(t0, s({ lead_minutes: 0 }), 300).releaseAt.getTime()).toBe(t0.getTime());
  });
  it('computeDayRelease uses day window end as pickup deadline', () => {
    const end = min(600);
    const r = computeDayRelease(t0, s(), end, 300);
    expect(r.pickupDeadline).toEqual(end);
    expect(r.releaseAt).toEqual(min(5));
    expect(r.windowEnd).toEqual(min(605));
  });
  it('formatDual', () => {
    expect(formatDual(new Date('2026-10-23T13:05:00Z'), 'America/Santo_Domingo')).toBe('2026-10-23 09:05 AST (13:05 UTC)');
  });
});
