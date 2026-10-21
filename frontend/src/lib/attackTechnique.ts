import { TECHNIQUE_NAMES } from '@/lib/attackTechniqueTactics';

/** ATT&CK name for a technique ID (e.g. 'T1486'), or undefined when unknown. */
export function techniqueName(id: string): string | undefined {
  return TECHNIQUE_NAMES[id.toUpperCase()];
}

/** attack.mitre.org page for a technique or sub-technique ID. */
export function attackTechniqueUrl(id: string): string {
  const [technique, sub] = id.toUpperCase().split('.');
  return `https://attack.mitre.org/techniques/${technique}/${sub ? `${sub}/` : ''}`;
}
