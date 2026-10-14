import { describe, it, expect } from 'vitest';
import { ATTACK_TECHNIQUES, techniqueInfo } from '../attackTechniques.js';
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

describe('renamed tactics', () => {
  it('resolves the tactics ATT&CK split out of Defense Evasion to Defense Evasion', () => {
    expect(tacticName('stealth')).toBe('Defense Evasion');
    expect(tacticName('Stealth')).toBe('Defense Evasion');
    expect(tacticName('Defense Impairment')).toBe('Defense Evasion');
    expect(tacticName('TA0112')).toBe('Defense Evasion');
  });

  it('ranks the split tactics at the Defense Evasion position', () => {
    expect(tacticRank(tacticName('stealth'))).toBe(tacticRank('Defense Evasion'));
    expect(tacticRank(tacticName('defense-impairment'))).toBe(tacticRank('Defense Evasion'));
  });
});

describe('generated technique table', () => {
  it('uses only tactic keys that tacticName resolves', () => {
    const unresolved = new Set<string>();
    for (const info of Object.values(ATTACK_TECHNIQUES)) {
      for (const key of info.tactics) {
        if (tacticName(key) === null) unresolved.add(key);
      }
    }
    expect([...unresolved]).toEqual([]);
  });
});

describe('revoked technique ids', () => {
  it('names a technique ATT&CK revoked and renumbered', () => {
    const info = techniqueInfo('T1562.001');
    expect(info?.name).toContain('Disable or Modify Tools');
    expect(info?.tactics.some((t) => tacticName(t) !== null)).toBe(true);
  });

  it('names every library id that ATT&CK revoked', () => {
    const revokedInLibrary = [
      'T1070.001', 'T1070.002', 'T1562.001', 'T1562.002',
      'T1562.004', 'T1562.006', 'T1562.008', 'T1574.002',
    ];
    for (const id of revokedInLibrary) {
      expect(techniqueInfo(id), id).not.toBeNull();
    }
  });
});
