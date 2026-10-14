// ATT&CK Enterprise tactics in kill-chain order. Hand-maintained: tactics
// change far less often than techniques (see attackTechniques.ts).

interface Tactic {
  id: string;
  key: string;
  name: string;
}

export const ATTACK_TACTICS: readonly Tactic[] = [
  { id: 'TA0043', key: 'reconnaissance', name: 'Reconnaissance' },
  { id: 'TA0042', key: 'resource-development', name: 'Resource Development' },
  { id: 'TA0001', key: 'initial-access', name: 'Initial Access' },
  { id: 'TA0002', key: 'execution', name: 'Execution' },
  { id: 'TA0003', key: 'persistence', name: 'Persistence' },
  { id: 'TA0004', key: 'privilege-escalation', name: 'Privilege Escalation' },
  { id: 'TA0005', key: 'defense-evasion', name: 'Defense Evasion' },
  { id: 'TA0006', key: 'credential-access', name: 'Credential Access' },
  { id: 'TA0007', key: 'discovery', name: 'Discovery' },
  { id: 'TA0008', key: 'lateral-movement', name: 'Lateral Movement' },
  { id: 'TA0009', key: 'collection', name: 'Collection' },
  { id: 'TA0011', key: 'command-and-control', name: 'Command and Control' },
  { id: 'TA0010', key: 'exfiltration', name: 'Exfiltration' },
  { id: 'TA0040', key: 'impact', name: 'Impact' },
];

const LOOKUP = new Map<string, Tactic>();
for (const t of ATTACK_TACTICS) {
  LOOKUP.set(t.id.toLowerCase(), t);
  LOOKUP.set(t.key, t);
  LOOKUP.set(t.name.toLowerCase(), t);
}

/** Display name for a tactic given as kebab key, TA id or display name. */
export function tacticName(value: string | null | undefined): string | null {
  if (!value) return null;
  return LOOKUP.get(value.trim().toLowerCase())?.name ?? null;
}

/** Kill-chain position of a tactic display name; unknown or null sorts last. */
export function tacticRank(name: string | null | undefined): number {
  const i = ATTACK_TACTICS.findIndex((t) => t.name === name);
  return i === -1 ? ATTACK_TACTICS.length : i;
}
