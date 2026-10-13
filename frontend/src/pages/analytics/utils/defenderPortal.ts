// Defender portal base. Alert docs carry an exact per-alert `portal_url`
// (alertWebUrl) — prefer it; the portal base + alert id is the fallback when
// an alert predates the portal_url sync (or lacks it for any reason).
export const DEFENDER_PORTAL_BASE = 'https://security.microsoft.com/alerts';

/** Best available Defender portal link for an alert. */
export function defenderAlertUrl(
  portalUrl: string | null | undefined,
  alertId?: string,
): string {
  if (portalUrl) return portalUrl;
  return alertId ? `${DEFENDER_PORTAL_BASE}/${alertId}` : DEFENDER_PORTAL_BASE;
}
