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
    const r = fleetResultText(test(), item(9, 12), 'ready');
    expect(r.text).toBe('9 / 12 endpoints protected');
    expect(r.share).toBe(0.75);
    expect(r.title).toBe('Latest result per endpoint, last 90 days · last run 3d ago');
  });

  it('reports cyber-hygiene results as checks passed', () => {
    const r = fleetResultText(test('cyber-hygiene'), item(34, 40), 'ready');
    expect(r.text).toBe('34 / 40 checks passed');
    expect(r.share).toBe(0.85);
  });

  it('says "Not run in 90 days" only once the fetch succeeded with no item', () => {
    const r = fleetResultText(test(), undefined, 'ready');
    expect(r.text).toBe('Not run in 90 days');
    expect(r.share).toBeNull();
  });

  it.each(['loading', 'error'] as const)('shows a neutral placeholder while %s', (state) => {
    const r = fleetResultText(test(), item(9, 12), state);
    expect(r.text).toBe('—');
    expect(r.share).toBeNull();
    expect(r.text).not.toMatch(/not run/i);
  });
});
