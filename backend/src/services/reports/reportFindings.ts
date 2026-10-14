// Ranked findings for the execution report (spec §5.6).
// Candidates: techniques with ≥ FINDING_MIN_RESULTS conclusive results and a
// stage protection rate below FINDING_RATE_CEILING. Ranked by unprotected
// share, weighted toward tactics that cause direct damage.

import { conclusiveCount } from './stageOutcome.js';
import { extractGuidanceExcerpt } from './guidanceExcerpt.js';
import type { ReportFinding, ReportTechnique, ReportTest } from '../../types/reports.js';

export const FINDINGS_MAX = 6;
export const FINDING_MIN_RESULTS = 3;
export const FINDING_RATE_CEILING = 0.75;
export const HIGH_IMPACT_WEIGHT = 1.5;
const HIGH_IMPACT_TACTIC_NAMES = ['Exfiltration', 'Impact'];

export function rankFindings(techniques: ReportTechnique[], tests: ReportTest[]): ReportFinding[] {
  const testsByKey = new Map(tests.map((t) => [t.testKey, t]));
  return techniques
    .map((t) => {
      const conclusive = conclusiveCount(t.outcomes);
      const defended = t.outcomes.protected + t.outcomes.prevented + t.outcomes.detected;
      const highImpact = t.tactic !== null && HIGH_IMPACT_TACTIC_NAMES.includes(t.tactic);
      const weight = conclusive === 0 ? 0 : (t.outcomes.unprotected / conclusive) * (highImpact ? HIGH_IMPACT_WEIGHT : 1);
      return { t, conclusive, rate: conclusive === 0 ? 1 : defended / conclusive, highImpact, weight };
    })
    .filter((c) => c.conclusive >= FINDING_MIN_RESULTS && c.rate < FINDING_RATE_CEILING)
    .sort((a, b) => b.weight - a.weight || b.conclusive - a.conclusive || a.t.id.localeCompare(b.t.id))
    .slice(0, FINDINGS_MAX)
    .map(({ t, highImpact }) => {
      const testKeys = [...t.testKeys].sort((a, b) => (testsByKey.get(b)?.runs ?? 0) - (testsByKey.get(a)?.runs ?? 0));
      return {
        techniqueId: t.id,
        techniqueName: t.name,
        tactic: t.tactic,
        highImpact,
        outcomes: t.outcomes,
        testKeys,
        testNames: testKeys.map((k) => testsByKey.get(k)?.name ?? k),
        acceptedRisk: false,
        guidance: null,
      };
    });
}

/**
 * Acceptance lookup keys are `test_name` or `test_name::control_id`; for
 * bundle stages test_name is the stage name (see getAcceptancesForControls).
 */
export function markAcceptedRisks(
  findings: ReportFinding[],
  tests: ReportTest[],
  acceptances: Record<string, unknown[]>,
): ReportFinding[] {
  const testsByKey = new Map(tests.map((t) => [t.testKey, t]));
  const covered = (key: string) => (acceptances[key]?.length ?? 0) > 0;
  return findings.map((f) => ({
    ...f,
    acceptedRisk: f.testKeys.some((k) => (testsByKey.get(k)?.stages ?? []).some((s) =>
      s.techniques.includes(f.techniqueId)
      && (covered(s.name) || (s.controlId !== null && covered(`${s.name}::${s.controlId}`))))),
  }));
}

export function attachGuidance(
  findings: ReportFinding[],
  tests: ReportTest[],
  readGuidance: (testKey: string) => string | null,
): ReportFinding[] {
  const names = new Map(tests.map((t) => [t.testKey, t.name]));
  const cache = new Map<string, string | null>();
  const read = (k: string): string | null => {
    if (!cache.has(k)) cache.set(k, readGuidance(k));
    return cache.get(k) ?? null;
  };
  return findings.map((f) => {
    let fallback: ReportFinding['guidance'] = null;
    for (const testKey of f.testKeys) {
      const markdown = read(testKey);
      if (markdown === null) continue;
      const guidance = { testKey, testName: names.get(testKey) ?? testKey, excerpt: extractGuidanceExcerpt(markdown, f.techniqueId) };
      if (guidance.excerpt) return { ...f, guidance };
      fallback ??= guidance;
    }
    return { ...f, guidance: fallback };
  });
}
