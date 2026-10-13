/**
 * Map vendor-normalized alert `prevention_action` tokens to human-readable
 * labels. Shared by CrowdStrike and Defender — both backends normalize their
 * native dispositions into the same vocabulary:
 *
 *   CrowdStrike (pattern_disposition_details):
 *     kill_action_failed                           → 'kill_failed'
 *     quarantine_file                              → 'quarantined'
 *     kill_process / kill_parent / kill_subprocess → 'process_killed'
 *     process_blocked / operation_blocked / ...    → 'blocked'
 *     (detection-only)                             → absent
 *
 *   Defender (evidence[].remediationStatus):
 *     'remediated' → 'quarantined'
 *     'blocked'    → 'process_killed'
 *     'prevented'  → 'blocked'
 *     (no completed prevention) → absent — Defender has no 'kill_failed'
 *
 * 'kill_failed' is deliberately NOT a prevention outcome — the vendor
 * attempted the kill and failed, so the action counts as detection-only.
 * The other three are vendor-confirmed prevention.
 */

export type PreventionAction = 'quarantined' | 'process_killed' | 'blocked' | 'kill_failed';

const PREVENTION_ACTION_LABELS: Record<PreventionAction, string> = {
  quarantined: 'quarantined',
  process_killed: 'process killed',
  blocked: 'blocked',
  kill_failed: 'kill failed',
};

/** Actions that count as vendor-confirmed prevention (kill_failed excluded). */
export const CONFIRMED_PREVENTION_ACTIONS: ReadonlySet<string> = new Set([
  'quarantined',
  'process_killed',
  'blocked',
]);

/**
 * Returns a display-friendly label for a prevention action token.
 *
 * - Known tokens → readable label (e.g., "process killed")
 * - empty / null / undefined → null (caller decides whether to render anything)
 * - anything else → the raw token with underscores spaced, so a new CrowdStrike
 *   action still renders something rather than silently disappearing
 */
export function formatPreventionAction(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw in PREVENTION_ACTION_LABELS) return PREVENTION_ACTION_LABELS[raw as PreventionAction];
  return raw.replace(/_/g, ' ');
}

/** True when the action is vendor-confirmed prevention (not a failed kill). */
export function isConfirmedPrevention(raw: string | null | undefined): boolean {
  return !!raw && CONFIRMED_PREVENTION_ACTIONS.has(raw);
}
