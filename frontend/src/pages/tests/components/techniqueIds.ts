const ATTACK_ID = /^T\d{4}(?:\.\d{3})?/;

/**
 * Normalise a test's technique list for display. Some library tests list both a bare
 * ID and a named variant ("T1003.001 (OS Credential Dumping: LSASS Memory)"), so each
 * entry is reduced to its leading ATT&CK ID (unmatched entries are kept trimmed),
 * blanks are dropped, and duplicates removed in first-seen order.
 */
export function techniqueIds(techniques: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of techniques) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    seen.add(ATTACK_ID.exec(trimmed)?.[0] ?? trimmed);
  }
  return [...seen];
}
