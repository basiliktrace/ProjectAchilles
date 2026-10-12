export type CrowdStrikeSeverity = 'critical' | 'high' | 'medium' | 'low' | 'informational' | 'unknown';

export interface SeverityTokens {
  text: string;
  bar: string;
  bg: string;
}

export const SEVERITY_TOKENS: Record<CrowdStrikeSeverity, SeverityTokens> = {
  critical: { text: 'text-red-600', bar: 'bg-red-600', bg: 'bg-red-600/10' },
  high: { text: 'text-red-500', bar: 'bg-red-500', bg: 'bg-red-500/10' },
  medium: { text: 'text-amber-500', bar: 'bg-amber-500', bg: 'bg-amber-500/10' },
  low: { text: 'text-blue-500', bar: 'bg-blue-500', bg: 'bg-blue-500/10' },
  informational: { text: 'text-muted-foreground', bar: 'bg-muted-foreground', bg: 'bg-muted/30' },
  unknown: { text: 'text-muted-foreground', bar: 'bg-muted-foreground', bg: 'bg-muted/30' },
};

export function getSeverityTokens(severity: string | undefined | null): SeverityTokens {
  const key = (severity ?? 'unknown').toLowerCase() as CrowdStrikeSeverity;
  return SEVERITY_TOKENS[key] ?? SEVERITY_TOKENS.unknown;
}
