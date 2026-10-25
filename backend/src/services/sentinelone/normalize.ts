import type { S1Threat } from '../../types/sentinelone.js';

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

/** Mitigation-report actions that are an attempt to stop the threat (not rollback / un-quarantine / network). */
const STOP_ACTIONS = new Set(['kill', 'quarantine', 'remediate']);

export function threatPreventionAction(t: S1Threat): string | undefined {
  const report = t.mitigationStatus ?? [];
  const done = (action: string) => report.some((m) => m.action === action && m.status === 'success');
  if (done('quarantine')) return 'quarantined';
  if (done('kill')) return 'process_killed';
  // Remediation (file removed / changes reverted) maps onto the shared
  // vocabulary like Defender's 'remediated' → 'quarantined'.
  if (done('remediate')) return 'quarantined';
  // 'kill_failed' only when the mitigation report shows a stop attempt
  // (kill / quarantine / remediate) that failed — not for any failed entry.
  if (report.some((m) => STOP_ACTIONS.has(m.action ?? '') && m.status === 'failed')) return 'kill_failed';
  if (t.threatInfo?.mitigationStatus === 'mitigated') return 'blocked';
  return undefined;
}
