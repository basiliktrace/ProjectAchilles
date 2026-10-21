// Severity grouping shared by the integration tabs.

export interface SeverityGroup {
  key: string;
  label: string;
  count: number;
}

const titleCase = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Known severities in the order given (zero counts included), then every other
 * key summed into `unclassified` (omitted when 0).
 */
export function groupSeverities(bySeverity: Record<string, number>, known: string[]): SeverityGroup[] {
  const out: SeverityGroup[] = known.map((key) => ({
    key,
    label: titleCase(key),
    count: bySeverity[key] ?? 0,
  }));
  let other = 0;
  for (const [key, count] of Object.entries(bySeverity)) {
    if (!known.includes(key)) other += count;
  }
  if (other > 0) out.push({ key: 'unclassified', label: 'Unclassified', count: other });
  return out;
}
