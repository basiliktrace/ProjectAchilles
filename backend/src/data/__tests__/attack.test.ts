import { describe, it, expect } from 'vitest';
import { techniqueInfo } from '../attackTechniques.js';
import { ATTACK_TACTICS, tacticName, tacticRank } from '../attackTactics.js';

describe('techniqueInfo', () => {
  it('names techniques and sub-techniques used by the library', () => {
    expect(techniqueInfo('T1486')?.name).toBe('Data Encrypted for Impact');
    expect(techniqueInfo('T1003.001')?.name).toBe('LSASS Memory');
    expect(techniqueInfo('T1567.002')?.name).toBe('Exfiltration to Cloud Storage');
  });

  it('is case-insensitive and returns tactics as kebab keys', () => {
    expect(techniqueInfo('t1059.001')?.tactics).toContain('execution');
  });

  it('returns null for unknown ids', () => {
    expect(techniqueInfo('T0000')).toBeNull();
  });
});

describe('tactics', () => {
  it('resolves kebab keys, TA ids and display names', () => {
    expect(tacticName('credential-access')).toBe('Credential Access');
    expect(tacticName('TA0010')).toBe('Exfiltration');
    expect(tacticName('Command and Control')).toBe('Command and Control');
    expect(tacticName('nope')).toBeNull();
    expect(tacticName(null)).toBeNull();
  });

  it('ranks tactics in kill-chain order, unknown last', () => {
    expect(tacticRank('Execution')).toBeLessThan(tacticRank('Impact'));
    expect(tacticRank(null)).toBe(ATTACK_TACTICS.length);
  });
});
