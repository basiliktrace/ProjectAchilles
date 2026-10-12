/**
 * Map CrowdStrike Falcon alert `product` / `scenario` tokens to human-readable
 * labels for display in the UI.
 *
 * CrowdStrike alerts carry a `product` field identifying the Falcon module
 * that raised the alert (e.g. "epp", "idp") and a `scenario` field describing
 * the detection category (e.g. "malware", "credential_theft"). Both are short
 * lowercase tokens that read poorly verbatim.
 *
 * We map known tokens to friendly labels and pass anything unrecognized
 * through raw so a new Falcon module or scenario still renders something
 * rather than silently disappearing. Empty / null inputs return null so
 * callers can choose whether to omit the meta line entirely.
 */

const KNOWN_PRODUCTS: Record<string, string> = {
  epp: 'Falcon Endpoint Protection',
  edr: 'Falcon Insight EDR',
  xdr: 'Falcon XDR',
  idp: 'Falcon Identity Protection',
  mobile: 'Falcon for Mobile',
  ngsiem: 'Falcon Next-Gen SIEM',
  overwatch: 'Falcon OverWatch',
  recon: 'Falcon Recon',
  spotlight: 'Falcon Spotlight',
};

const KNOWN_SCENARIOS: Record<string, string> = {
  malware: 'Malware',
  credential_theft: 'Credential Theft',
  suspicious_activity: 'Suspicious Activity',
  exploit: 'Exploit',
  ransomware: 'Ransomware',
  reconnaissance: 'Reconnaissance',
  lateral_movement: 'Lateral Movement',
  persistence: 'Persistence',
  exfiltration: 'Exfiltration',
  command_and_control: 'Command & Control',
};

const UNKNOWN_TOKENS = new Set(['unknown', 'unknownFutureValue']);

/**
 * Returns a display-friendly label for a CrowdStrike product or scenario token.
 *
 * - Known tokens → readable label (e.g., "Falcon Identity Protection")
 * - `unknown` → "Other"
 * - empty / null / undefined → null (caller decides whether to render anything)
 * - anything else → the raw value (so a new Falcon token still renders
 *   something rather than silently disappearing)
 */
export function formatCrowdStrikeProduct(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (KNOWN_PRODUCTS[raw]) return KNOWN_PRODUCTS[raw];
  if (UNKNOWN_TOKENS.has(raw)) return 'Other';
  return raw;
}

export function formatCrowdStrikeScenario(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (KNOWN_SCENARIOS[raw]) return KNOWN_SCENARIOS[raw];
  if (UNKNOWN_TOKENS.has(raw)) return 'Other';
  return raw;
}
