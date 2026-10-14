import { describe, it, expect } from 'vitest';
import {
  ALL_TIME_FROM,
  chooseBucket,
  computeTimeAxis,
  floorToBucket,
  parseBound,
  resolveReportWindow,
  validateTimeZone,
} from '../reportWindow.js';

const NOW = new Date('2026-10-13T23:40:00.000Z');
const H = 3_600_000;
const D = 86_400_000;

function statusOf(fn: () => unknown): number | undefined {
  try { fn(); } catch (err) { return (err as { statusCode?: number }).statusCode; }
  return undefined;
}

describe('parseBound', () => {
  it('resolves ES date math against now', () => {
    expect(parseBound('now', NOW).toISOString()).toBe(NOW.toISOString());
    expect(parseBound('now-30d', NOW).toISOString()).toBe('2026-09-13T23:40:00.000Z');
    expect(parseBound('now-12h', NOW).toISOString()).toBe('2026-10-13T11:40:00.000Z');
    expect(parseBound('now-1w', NOW).toISOString()).toBe('2026-10-06T23:40:00.000Z');
    expect(parseBound('now-1M', NOW).toISOString()).toBe('2026-09-13T23:40:00.000Z');
  });

  it('passes ISO strings through, honoring offsets', () => {
    expect(parseBound('2026-10-01T00:00:00-04:00', NOW).toISOString()).toBe('2026-10-01T04:00:00.000Z');
  });

  it('rejects anything else with a 400', () => {
    expect(statusOf(() => parseBound('yesterday', NOW))).toBe(400);
  });

  it('rejects relative bounds whose date overflows instead of returning Invalid Date', () => {
    expect(statusOf(() => parseBound('now-99999999999999d', NOW))).toBe(400);
    expect(statusOf(() => parseBound('now-99999999999999y', NOW))).toBe(400);
    expect(statusOf(() => parseBound('now-99999999999999M', NOW))).toBe(400);
  });

  it('rejects non-ISO input instead of guessing with the legacy Date parser', () => {
    expect(statusOf(() => parseBound('12', NOW))).toBe(400);
    expect(statusOf(() => parseBound('Oct 5', NOW))).toBe(400);
    expect(statusOf(() => parseBound('2026-10-01T00:00:00.1234Z', NOW))).toBe(400);
  });

  it('reads offset-less ISO bounds as UTC, matching Elasticsearch', () => {
    expect(parseBound('2026-10-01T00:00:00', NOW).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(parseBound('2026-10-01', NOW).toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('honors an explicit offset on ISO bounds', () => {
    expect(parseBound('2026-10-01T00:00:00+02:00', NOW).toISOString()).toBe('2026-09-30T22:00:00.000Z');
  });

  it('rejects impossible calendar values with a 400', () => {
    expect(statusOf(() => parseBound('2026-13-45', NOW))).toBe(400);
  });
});

describe('resolveReportWindow', () => {
  it('derives the preset from a relative lower bound', () => {
    expect(resolveReportWindow({ from: 'now-30d' }, NOW)).toEqual({
      preset: '30d',
      label: 'Last 30 days',
      effectiveFrom: '2026-09-13T23:40:00.000Z',
      effectiveTo: NOW.toISOString(),
    });
  });

  it('labels the All-time lower bound', () => {
    expect(resolveReportWindow({ from: ALL_TIME_FROM }, NOW)).toMatchObject({
      preset: 'all', label: 'All time', effectiveFrom: ALL_TIME_FROM, effectiveTo: NOW.toISOString(),
    });
  });

  it('mirrors the backend 7-day default when no bounds are sent', () => {
    expect(resolveReportWindow({}, NOW)).toMatchObject({
      preset: '7d', label: 'Last 7 days', effectiveFrom: '2026-10-06T23:40:00.000Z',
    });
  });

  it('treats an upper bound alone as unbounded below (custom range)', () => {
    expect(resolveReportWindow({ to: '2026-10-01T00:00:00Z' }, NOW)).toMatchObject({
      preset: 'custom', effectiveFrom: ALL_TIME_FROM, effectiveTo: '2026-10-01T00:00:00.000Z',
    });
  });

  it('keeps custom bounds exact to the minute', () => {
    expect(resolveReportWindow({ from: '2026-10-12T12:00:00Z', to: '2026-10-12T15:30:00Z' }, NOW)).toMatchObject({
      preset: 'custom', label: 'Custom range',
      effectiveFrom: '2026-10-12T12:00:00.000Z', effectiveTo: '2026-10-12T15:30:00.000Z',
    });
  });

  it('labels relative spans without a preset as custom', () => {
    expect(resolveReportWindow({ from: 'now-12h' }, NOW).preset).toBe('custom');
  });

  it('rejects an overflowing relative bound with a 400, whether from or to', () => {
    expect(statusOf(() => resolveReportWindow({ from: 'now-99999999999999d' }, NOW))).toBe(400);
    expect(statusOf(() => resolveReportWindow({ to: 'now-99999999999999d' }, NOW))).toBe(400);
  });

  it('rejects from >= to with a 400', () => {
    expect(statusOf(() => resolveReportWindow({ from: '2026-10-12T00:00:00Z', to: '2026-10-11T00:00:00Z' }, NOW))).toBe(400);
  });
});

describe('chooseBucket', () => {
  it.each([
    [48 * H, 'hour'],
    [48 * H + 1, 'day'],
    [60 * D, 'day'],
    [60 * D + 1, 'week'],
    [400 * D, 'week'],
    [400 * D + 1, 'month'],
  ])('span %d ms → %s', (span, bucket) => {
    expect(chooseBucket(span)).toBe(bucket);
  });
});

describe('floorToBucket', () => {
  it('floors in UTC, weeks to Monday', () => {
    expect(floorToBucket('2026-10-13T23:40:00.000Z', 'hour')).toBe('2026-10-13T23:00:00.000Z');
    expect(floorToBucket('2026-10-13T23:40:00.000Z', 'day')).toBe('2026-10-13T00:00:00.000Z');
    expect(floorToBucket('2026-10-13T23:40:00.000Z', 'week')).toBe('2026-10-12T00:00:00.000Z');
    expect(floorToBucket('2026-10-13T23:40:00.000Z', 'month')).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('computeTimeAxis', () => {
  it('uses the selected window for bounded ranges', () => {
    const w = resolveReportWindow({ from: 'now-30d' }, NOW);
    expect(computeTimeAxis(w, '2026-10-10T08:00:00.000Z')).toEqual({
      axisFrom: w.effectiveFrom, axisTo: w.effectiveTo, bucket: 'day',
    });
  });

  it('starts an All-time axis at the first execution, floored to the bucket', () => {
    const w = resolveReportWindow({ from: ALL_TIME_FROM }, NOW);
    expect(computeTimeAxis(w, '2026-03-04T17:22:00.000Z')).toEqual({
      axisFrom: '2026-03-02T00:00:00.000Z', axisTo: NOW.toISOString(), bucket: 'week',
    });
  });

  it('picks hourly buckets for a one-day window', () => {
    expect(computeTimeAxis(resolveReportWindow({ from: 'now-1d' }, NOW), null).bucket).toBe('hour');
  });

  it('falls back to a one-day axis when All time has no executions', () => {
    const w = resolveReportWindow({ from: ALL_TIME_FROM }, NOW);
    expect(computeTimeAxis(w, null)).toEqual({
      axisFrom: '2026-10-12T23:00:00.000Z', axisTo: NOW.toISOString(), bucket: 'hour',
    });
  });
});

describe('validateTimeZone', () => {
  it('accepts IANA zones and rejects unknown ones with a 400', () => {
    expect(validateTimeZone('America/Santo_Domingo')).toBe('America/Santo_Domingo');
    expect(statusOf(() => validateTimeZone('Mars/Olympus_Mons'))).toBe(400);
  });

  it('returns the canonical spelling of the zone', () => {
    expect(validateTimeZone('america/santo_domingo')).toBe('America/Santo_Domingo');
  });
});
