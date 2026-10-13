import { integrationsApi, type CrowdStrikeRegion } from '@/services/api/integrations';

// Falcon console base per cloud region. Alert docs carry an exact per-alert
// `portal_url` (falcon_host_link) — prefer it; these bases are the fallback
// when an alert predates the portal_url sync (or lacks it for any reason).
export const FALCON_CONSOLE_BASES: Record<CrowdStrikeRegion, string> = {
  'us-1': 'https://falcon.crowdstrike.com',
  'us-2': 'https://falcon.us-2.crowdstrike.com',
  'eu-1': 'https://falcon.eu-1.crowdstrike.com',
  'us-gov-1': 'https://falcon.laggar.gcw.crowdstrike.com',
};

export const DEFAULT_FALCON_CONSOLE_BASE = FALCON_CONSOLE_BASES['us-1'];

/**
 * Best available Falcon console link for an alert: the exact per-alert
 * `portal_url` when present, otherwise the region's alerts console
 * (us-1 base when no region is known — e.g. callers without settings access).
 */
export function falconAlertUrl(
  portalUrl: string | null | undefined,
  regionBase?: string,
): string {
  if (portalUrl) return portalUrl;
  return `${regionBase ?? getFalconConsoleBase()}/alerts`;
}

// Region is fetched once per session and shared between the drawer (which
// resolves it on open) and the executions panel (which renders rows
// synchronously and just reads the cache).
let cachedConsoleBase: string | null = null;

/** Synchronously cached console base — us-1 until the first resolve lands. */
export function getFalconConsoleBase(): string {
  return cachedConsoleBase ?? DEFAULT_FALCON_CONSOLE_BASE;
}

/** Resolve the configured region's console base; cached module-wide. */
export async function resolveFalconConsoleBase(): Promise<string> {
  try {
    const settings = await integrationsApi.getCrowdStrikeSettings();
    if (settings.region && FALCON_CONSOLE_BASES[settings.region]) {
      cachedConsoleBase = FALCON_CONSOLE_BASES[settings.region];
    }
  } catch {
    // Unreachable settings → keep the us-1 default.
  }
  return getFalconConsoleBase();
}
