import { describe, it, expect } from 'vitest';
import {
  parseWindowQuery, windowRange, trendInterval, parseAlertSource, parseSeverityList,
} from '../integration-window.js';

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

  it('parseWindowQuery returns the window for valid bounds, normalised to toISOString()', () => {
    expect(parseWindowQuery({ from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' })).toEqual({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z',
    });
    expect(parseWindowQuery({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.123Z' })).toEqual({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-02T00:00:00.123Z',
    });
  });

  it('parseWindowQuery accepts date-only bounds (UTC midnight) and ±HH:MM offsets', () => {
    expect(parseWindowQuery({ from: '2026-10-01', to: '2026-10-20' })).toEqual({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-20T00:00:00.000Z',
    });
    expect(parseWindowQuery({ from: '2026-10-01T02:00:00+02:00', to: '2026-10-20T00:00:00.5-05:30' })).toEqual({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-20T05:30:00.500Z',
    });
  });

  it('parseWindowQuery rejects every non-strict-ISO form Date.parse would accept', () => {
    const to = '2026-10-21T00:00:00Z';
    for (const from of [
      'Oct 20 2026',            // free-form date
      '2026/10/20',             // slashes
      '2026-10-20 10:00',       // space separator, no zone
      '2026-10-20T10:00:00',    // zone-less date-time (local in JS, UTC in ES)
      '2026-10-20T10:00Z',      // no seconds
      '1',                      // 2001 in JS, epoch_millis in ES
      '1760918400000',          // epoch millis
      '2026-02-30',             // not a calendar date
      '2026-13-01T00:00:00Z',   // month 13
    ]) {
      expect400({ from, to });
      expect400({ from: '2026-01-01T00:00:00Z', to: from });
    }
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

describe('alert filter params', () => {
  it('parseAlertSource accepts all/test/organic and treats absent as undefined', () => {
    expect(parseAlertSource(undefined)).toBeUndefined();
    expect(parseAlertSource('')).toBeUndefined();
    expect(parseAlertSource('all')).toBe('all');
    expect(parseAlertSource('test')).toBe('test');
    expect(parseAlertSource('organic')).toBe('organic');
  });

  it("parseAlertSource rejects anything else with 400 'Invalid source'", () => {
    for (const bad of ['bogus', ['test', 'organic']]) {
      try {
        parseAlertSource(bad);
      } catch (e) {
        expect((e as { statusCode: number }).statusCode).toBe(400);
        expect((e as Error).message).toBe('Invalid source');
        continue;
      }
      throw new Error('expected throw');
    }
  });

  it('parseSeverityList splits, trims and lowercases a comma list', () => {
    expect(parseSeverityList(undefined)).toBeUndefined();
    expect(parseSeverityList('')).toBeUndefined();
    expect(parseSeverityList(' , ')).toBeUndefined();
    expect(parseSeverityList('high')).toEqual(['high']);
    expect(parseSeverityList('High, critical,')).toEqual(['high', 'critical']);
  });
});
