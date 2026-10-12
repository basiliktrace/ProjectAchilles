import { describe, it, expect } from 'vitest';
import { getSeverityTokens, SEVERITY_TOKENS } from '../crowdstrikeSeverityTokens';

describe('getSeverityTokens', () => {
  it('returns the critical bucket for CrowdStrike Critical alerts', () => {
    // CrowdStrike adds a Critical tier above High that Defender lacks —
    // it must get its own token set, not fall through to unknown.
    expect(getSeverityTokens('critical')).toBe(SEVERITY_TOKENS.critical);
    expect(SEVERITY_TOKENS.critical.text).not.toBe(SEVERITY_TOKENS.high.text);
  });

  it('matches severities case-insensitively (CrowdStrike emits severity_name TitleCase)', () => {
    expect(getSeverityTokens('Critical')).toBe(SEVERITY_TOKENS.critical);
    expect(getSeverityTokens('High')).toBe(SEVERITY_TOKENS.high);
    expect(getSeverityTokens('INFORMATIONAL')).toBe(SEVERITY_TOKENS.informational);
  });

  it('maps the standard buckets', () => {
    expect(getSeverityTokens('high')).toBe(SEVERITY_TOKENS.high);
    expect(getSeverityTokens('medium')).toBe(SEVERITY_TOKENS.medium);
    expect(getSeverityTokens('low')).toBe(SEVERITY_TOKENS.low);
    expect(getSeverityTokens('informational')).toBe(SEVERITY_TOKENS.informational);
  });

  it('falls back to the unknown bucket for null / undefined / empty', () => {
    expect(getSeverityTokens(null)).toBe(SEVERITY_TOKENS.unknown);
    expect(getSeverityTokens(undefined)).toBe(SEVERITY_TOKENS.unknown);
    expect(getSeverityTokens('')).toBe(SEVERITY_TOKENS.unknown);
  });

  it('falls back to the unknown bucket for unrecognized severities', () => {
    // A future CrowdStrike severity tier must still render — better to look
    // muted than to crash or vanish.
    expect(getSeverityTokens('catastrophic')).toBe(SEVERITY_TOKENS.unknown);
  });

  it('gives every bucket a text, bar, and bg token', () => {
    for (const tokens of Object.values(SEVERITY_TOKENS)) {
      expect(tokens.text).toBeTruthy();
      expect(tokens.bar).toBeTruthy();
      expect(tokens.bg).toBeTruthy();
    }
  });
});
