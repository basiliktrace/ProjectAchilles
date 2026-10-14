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

// Newer ATT&CK releases split Defense Evasion (TA0005, now named Stealth) and
// moved part of it into Defense Impairment (TA0112). The ES test docs, the
// f0_library metadata and the console all still group these under
// defense-evasion, so these names resolve to that row rather than adding rows.
const ALIASES: Record<string, string> = {
  stealth: 'TA0005',
  'defense impairment': 'TA0005',
  TA0112: 'TA0005',
};

/** Lookup form: trimmed, lowercase, runs of spaces or hyphens as one space. */
function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, ' ');
}

const LOOKUP = new Map<string, Tactic>();
for (const t of ATTACK_TACTICS) {
  LOOKUP.set(normalise(t.id), t);
  LOOKUP.set(normalise(t.key), t);
  LOOKUP.set(normalise(t.name), t);
}
for (const [alias, id] of Object.entries(ALIASES)) {
  const tactic = ATTACK_TACTICS.find((t) => t.id === id);
  if (!tactic) throw new Error(`attackTactics: alias "${alias}" points at unknown tactic ${id}`);
  LOOKUP.set(normalise(alias), tactic);
}

/** Display name for a tactic given as kebab key, TA id, display name or alias. */
export function tacticName(value: string | null | undefined): string | null {
  if (!value) return null;
  return LOOKUP.get(normalise(value))?.name ?? null;
}

/** Kill-chain position of a tactic in any tacticName form; unknown or null sorts last. */
export function tacticRank(name: string | null | undefined): number {
  const resolved = tacticName(name);
  const i = ATTACK_TACTICS.findIndex((t) => t.name === resolved);
  return i === -1 ? ATTACK_TACTICS.length : i;
}
