import { describe, it, expect } from 'vitest';
import { parseWindowQuery, windowRange, trendInterval } from '../integration-window.js';

const expect400 = (q: Record<string, unknown>) => {
  try {
    parseWindowQuery(q);
  } catch (e) {
    expect((e as { statusCode: number }).statusCode).toBe(400);
    expect((e as Error).message).toBe('Invalid from/to');
    return;
  }
  throw new Error('expected throw');
};

describe('integration-window', () => {
  it('parseWindowQuery returns null when from and to are absent', () => {
    expect(parseWindowQuery({})).toBeNull();
  });

  it("parseWindowQuery rejects only-one-bound, unparsable and from>=to with 400 'Invalid from/to'", () => {
    expect400({ from: '2026-01-01T00:00:00Z' });
    expect400({ to: '2026-01-01T00:00:00Z' });
    expect400({ from: 'nope', to: '2026-01-01T00:00:00Z' });
    expect400({ from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' });
    expect400({ from: '2026-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' });
  });

  it('parseWindowQuery returns the window for valid bounds', () => {
    expect(parseWindowQuery({ from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' })).toEqual({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-02T00:00:00Z',
    });
  });

  it('trendInterval is day at exactly 90 days and week at 91', () => {
    const from = '2026-01-01T00:00:00.000Z';
    const at = (days: number) => new Date(Date.parse(from) + days * 86_400_000).toISOString();
    expect(trendInterval({ from, to: at(90) })).toBe('day');
    expect(trendInterval({ from, to: at(91) })).toBe('week');
  });

  it('windowRange builds gte/lte on the given field', () => {
    expect(windowRange('routing.event_time', { from: 'a', to: 'b' })).toEqual({
      range: { 'routing.event_time': { gte: 'a', lte: 'b' } },
    });
    expect(windowRange('x', null)).toBeNull();
  });
});
