/**
 * S1 returns incident status / analyst verdict in two vocabularies:
 * `/threats` uses snake_case (`in_progress`, `false_positive`) while
 * `/cloud-detection/alerts` uses display case (`In progress`, `False positive`).
 * Normalize both to the lowercase snake_case the shared facets and the
 * correlation time window expect (`resolved`, `closed`, ...).
 */
export function normalizeToken(raw: string | undefined): string {
  return (raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}
