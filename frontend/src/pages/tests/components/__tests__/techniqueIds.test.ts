import { describe, it, expect } from 'vitest';
import { techniqueIds } from '../techniqueIds';

describe('techniqueIds', () => {
  it('collapses a bare ID and its named variant to one ID', () => {
    expect(techniqueIds(['T1003.001', 'T1003.001 (OS Credential Dumping: LSASS Memory)'])).toEqual(['T1003.001']);
  });

  it('strips " - name" and " (name)" suffixes', () => {
    expect(techniqueIds(['T1562.001 - Impair Defenses: Disable or Modify Tools', 'T1219 (Remote Access Software)'])).toEqual([
      'T1562.001',
      'T1219',
    ]);
  });

  it('keeps unmatched entries trimmed and dedupes in first-seen order', () => {
    expect(techniqueIds(['  custom  ', 'T1059', 'T1059 (Command)', 'custom', 'T1105'])).toEqual(['custom', 'T1059', 'T1105']);
  });

  it('drops blank entries', () => {
    expect(techniqueIds(['', '   ', 'T1486'])).toEqual(['T1486']);
  });
});
