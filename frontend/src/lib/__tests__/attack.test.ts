import { describe, it, expect } from 'vitest';
import { tacticsForTechnique } from '../attack';

describe('tacticsForTechnique', () => {
  it('maps a technique to its tactics', () => {
    expect(tacticsForTechnique('T1059')).toContain('execution');
    expect(tacticsForTechnique('T1003')).toContain('credential-access');
  });
  it('falls back to the parent for sub-techniques', () => {
    expect(tacticsForTechnique('T1059.001')).toEqual(tacticsForTechnique('T1059'));
    expect(tacticsForTechnique('T1059.001').length).toBeGreaterThan(0);
  });
  it('returns [] for unknown ids', () => {
    expect(tacticsForTechnique('T9999')).toEqual([]);
    expect(tacticsForTechnique('')).toEqual([]);
  });
  it('is case-insensitive', () => {
    expect(tacticsForTechnique('t1059')).toContain('execution');
    expect(tacticsForTechnique('t1059.001')).toEqual(tacticsForTechnique('T1059'));
  });
  it('returns multiple tactics for multi-tactic techniques', () => {
    expect(tacticsForTechnique('T1053')).toEqual(
      expect.arrayContaining(['execution', 'persistence', 'privilege-escalation']),
    );
  });
});

describe('tacticsForTechnique revoked ids', () => {
  it('resolves a revoked/renumbered technique', () => {
    expect(tacticsForTechnique('T1077').length).toBeGreaterThan(0);
  });
});
