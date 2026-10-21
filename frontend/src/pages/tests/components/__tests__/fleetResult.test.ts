import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TestMetadata } from '@/types/test';
import type { TestResultItem } from '@/services/api/analytics';
import { fleetResultText } from '../fleetResult';

const test = (category = 'intel-driven'): TestMetadata => ({
  uuid: 'u1',
  name: 'Test one',
  techniques: [],
  isMultiStage: false,
  stages: [],
  category,
});

const item = (protectedCount: number, pairCount: number): TestResultItem => ({
  testUuid: 'u1',
  pairCount,
  protectedCount,
  hostCount: pairCount,
  lastRunAt: '2026-10-18T09:00:00.000Z',
});

describe('fleetResultText', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('reports protected endpoints with the protected share', () => {
    const r = fleetResultText(test(), item(9, 12), 'ready', true);
    expect(r.text).toBe('9 / 12 endpoints protected');
    expect(r.share).toBe(0.75);
    expect(r.title).toBe('Latest result per endpoint, last 90 days · last run 3d ago');
  });

  it('reports cyber-hygiene results as checks passed', () => {
    const r = fleetResultText(test('cyber-hygiene'), item(34, 40), 'ready', true);
    expect(r.text).toBe('34 / 40 checks passed');
    expect(r.share).toBe(0.85);
  });

  it('says "Not run yet" when executed is false and there is no item', () => {
    const r = fleetResultText(test(), undefined, 'ready', false);
    expect(r.text).toBe('Not run yet');
    expect(r.share).toBeNull();
    expect(r.title).toBe('No results from any endpoint');
  });

  it.each([true, null])('says "No conclusive result in 90 days" when executed is %s and there is no item', (executed) => {
    const r = fleetResultText(test(), undefined, 'ready', executed);
    expect(r.text).toBe('No conclusive result in 90 days');
    expect(r.share).toBeNull();
    expect(r.title).toBe(
      "No endpoint returned protected or unprotected in the last 90 days. Errors, blocks before execution, skipped stages and risk-accepted results don't count.",
    );
  });

  it.each(['loading', 'error'] as const)('shows a neutral placeholder while %s', (state) => {
    const r = fleetResultText(test(), item(9, 12), state, true);
    expect(r.text).toBe('—');
    expect(r.share).toBeNull();
    expect(r.text).not.toMatch(/not run/i);
  });
});
