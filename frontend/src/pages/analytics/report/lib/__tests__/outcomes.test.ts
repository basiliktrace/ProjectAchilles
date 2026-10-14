import { describe, it, expect } from 'vitest';
import { bandOf, conclusive, defended, protectionRate, shapeOf, sumCounts, tacticLabel, COUNTED_OUTCOMES } from '../outcomes';
import { counts } from '../../__tests__/fixtures';

describe('outcomes', () => {
  it('excludes skipped stages from counted outcomes', () => {
    expect(COUNTED_OUTCOMES).not.toContain('skipped');
  });

  it('computes the stage protection rate from conclusive results only', () => {
    const c = counts({ protected: 2, prevented: 1, detected: 1, unprotected: 4, inconclusive: 9, skipped: 3 });
    expect(conclusive(c)).toBe(8);
    expect(defended(c)).toBe(4);
    expect(protectionRate(c)).toBe(0.5);
    expect(protectionRate(counts({ inconclusive: 3 }))).toBeNull();
  });

  it('bands rates as Held / Partial / Gap', () => {
    expect(bandOf(0.75)).toBe('held');
    expect(bandOf(0.4)).toBe('partial');
    expect(bandOf(0.39)).toBe('gap');
    expect(bandOf(null)).toBe('none');
  });

  it('doubles color with shape (Status Rule)', () => {
    expect(shapeOf('protected')).toBe('square');
    expect(shapeOf('prevented')).toBe('square');
    expect(shapeOf('detected')).toBe('square');
    expect(shapeOf('unprotected')).toBe('circle');
    expect(shapeOf('inconclusive')).toBe('hollow');
  });

  it('sums counts and humanizes tactics', () => {
    expect(sumCounts([counts({ protected: 1 }), counts({ protected: 2, detected: 1 })])).toEqual(counts({ protected: 3, detected: 1 }));
    expect(tacticLabel('command-and-control')).toBe('Command and Control');
    expect(tacticLabel('credential-access')).toBe('Credential Access');
    expect(tacticLabel('TA0010')).toBe('TA0010');
  });

  it('passes backend tactic display names through unchanged', () => {
    expect(tacticLabel('Defense Evasion')).toBe('Defense Evasion');
    expect(tacticLabel('Command and Control')).toBe('Command and Control');
    expect(tacticLabel('Lateral Movement')).toBe('Lateral Movement');
  });

  it('title-cases single-word and hyphenated tactic slugs', () => {
    expect(tacticLabel('impact')).toBe('Impact');
    expect(tacticLabel('exfiltration')).toBe('Exfiltration');
    expect(tacticLabel('execution')).toBe('Execution');
    expect(tacticLabel('stealth')).toBe('Stealth');
    expect(tacticLabel('defense-evasion')).toBe('Defense Evasion');
    expect(tacticLabel('command-and-control')).toBe('Command and Control');
  });

  it('leaves ids and non-slug values unchanged', () => {
    expect(tacticLabel('TA0010')).toBe('TA0010');
    expect(tacticLabel('Defense Evasion')).toBe('Defense Evasion');
  });
});
