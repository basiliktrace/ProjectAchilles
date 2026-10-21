import { TECHNIQUE_TACTICS } from '@/lib/attackTechniqueTactics';

/**
 * Tactic slugs a technique belongs to. Case-insensitive; a sub-technique
 * (T1059.001) resolves to its parent's tactics; unknown IDs yield [].
 */
export function tacticsForTechnique(id: string): string[] {
  const parent = id.trim().toUpperCase().split('.')[0];
  return [...(TECHNIQUE_TACTICS[parent] ?? [])];
}
