import { describe, it, expect } from 'vitest';
import { techniqueName, attackTechniqueUrl } from '@/lib/attackTechnique';

describe('techniqueName', () => {
  it('resolves technique and sub-technique names', () => {
    expect(techniqueName('T1486')).toBe('Data Encrypted for Impact');
    expect(techniqueName('T1059.001')).toBe('PowerShell');
  });
  it('returns undefined for unknown ids', () => {
    expect(techniqueName('T9999')).toBeUndefined();
  });
});

describe('attackTechniqueUrl', () => {
  it('builds sub-technique and technique URLs', () => {
    expect(attackTechniqueUrl('T1059.001')).toBe('https://attack.mitre.org/techniques/T1059/001/');
    expect(attackTechniqueUrl('T1486')).toBe('https://attack.mitre.org/techniques/T1486/');
  });
});
