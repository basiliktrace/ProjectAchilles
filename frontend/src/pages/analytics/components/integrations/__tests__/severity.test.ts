import { describe, it, expect } from 'vitest';
import { groupSeverities } from '../severity';

const CS = ['critical', 'high', 'medium', 'low', 'informational'];

describe('groupSeverities', () => {
  it('folds unknown keys into Unclassified and keeps known order', () => {
    expect(groupSeverities({ high: 20, unknown: 6 }, CS)).toEqual([
      { key: 'critical', label: 'Critical', count: 0 },
      { key: 'high', label: 'High', count: 20 },
      { key: 'medium', label: 'Medium', count: 0 },
      { key: 'low', label: 'Low', count: 0 },
      { key: 'informational', label: 'Informational', count: 0 },
      { key: 'unclassified', label: 'Unclassified', count: 6 },
    ]);
  });

  it('omits Unclassified when there are no other keys', () => {
    const out = groupSeverities({ high: 2 }, ['high', 'low']);
    expect(out.map((o) => o.key)).toEqual(['high', 'low']);
  });

  it('sums match the input total', () => {
    const input = { critical: 1, high: 20, weird: 3, other: 4 };
    const out = groupSeverities(input, CS);
    expect(out.reduce((a, o) => a + o.count, 0)).toBe(28);
  });
});
