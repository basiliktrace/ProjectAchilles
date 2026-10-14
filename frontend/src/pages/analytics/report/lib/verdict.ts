// Deterministic narrative for the executive summary (spec §5.4). Each
// sentence appears only when its condition holds; no LLM involved.
import type { ExecutionReport, ReportTechnique } from '@/services/api/reports';
import { conclusive, defended, protectionRate } from './outcomes';
import { fmtPct, plural } from './format';
import { halvesTrend } from './timeline';

const STRENGTH_MIN_RESULTS = 5;
const STRENGTH_RATE = 0.9;
const GAP_RATE = 0.4;

export const FILTER_LABELS: Record<string, string> = {
  org: 'Organization',
  result: 'Result',
  hostnames: 'Endpoints',
  tests: 'Tests',
  techniques: 'Techniques',
  categories: 'Categories',
  severities: 'Severities',
  threatActors: 'Threat actors',
  tags: 'Tags',
  errorNames: 'Error names',
  errorCodes: 'Exit codes',
  bundleNames: 'Bundles',
};

/** "Result is unprotected and Exit codes is 101", or null when no outcome filter is on. */
export function describeOutcomeFilters(report: ExecutionReport): string | null {
  const keys = report.meta.outcomeFiltered.map((f) => f.split('=')[0]);
  if (keys.length === 0) return null;
  return keys.map((k) => `${FILTER_LABELS[k] ?? k} is ${report.meta.filters[k] ?? ''}`).join(' and ');
}

const label = (t: ReportTechnique) => (t.name ? `${t.name} (${t.id})` : t.id);

export function buildVerdict(report: ExecutionReport): string[] {
  const sentences: string[] = [];
  const outcomeFilter = describeOutcomeFilters(report);
  if (outcomeFilter) {
    sentences.push(`This report includes only executions where ${outcomeFilter}. Its rates describe that subset, not overall defensive posture.`);
  }

  const totals = report.totals.outcomes;
  const n = conclusive(totals);
  if (n === 0) {
    sentences.push('No stage result reached a verdict in this period.');
    return sentences;
  }
  sentences.push(
    `Across ${plural(report.totals.runs, 'run')} on ${plural(report.totals.endpoints, 'endpoint')}, ${defended(totals)} of ${n} conclusive stage results were protected, prevented or detected (${fmtPct(protectionRate(totals))}).`,
  );

  const rated = report.techniques
    .map((t) => ({ t, n: conclusive(t.outcomes), rate: protectionRate(t.outcomes) }))
    .filter((x) => x.n >= STRENGTH_MIN_RESULTS && x.rate !== null);

  const strength = rated
    .filter((x) => (x.rate ?? 0) >= STRENGTH_RATE)
    .sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0) || b.n - a.n)[0];
  if (strength) {
    sentences.push(`${label(strength.t)} was stopped or detected in ${defended(strength.t.outcomes)} of ${strength.n} attempts.`);
  }

  for (const gap of rated.filter((x) => (x.rate ?? 1) < GAP_RATE).sort((a, b) => (a.rate ?? 0) - (b.rate ?? 0) || b.n - a.n).slice(0, 2)) {
    sentences.push(`${label(gap.t)} got through in ${gap.t.outcomes.unprotected} of ${gap.n} attempts without being stopped or detected.`);
  }

  const hi = report.totals.highImpactUnprotected;
  if (hi > 0) {
    sentences.push(`${plural(hi, 'exfiltration or impact stage result')} ran without being stopped or detected.`);
  }

  const halves = halvesTrend(report.timeline.buckets, report.meta.window.axisFrom, report.meta.window.axisTo);
  if (halves) {
    const [a, b] = [fmtPct(halves.first), fmtPct(halves.second)];
    sentences.push(a === b
      ? `The stage protection rate held steady at ${a} across the period.`
      : `The stage protection rate moved from ${a} in the first half of the period to ${b} in the second.`);
  }

  const ds = report.defenseScore;
  if (ds && ds.score !== null) {
    const raw = ds.rawScore !== null ? `, or ${Math.round(ds.rawScore)}% before ${plural(ds.riskAcceptedCount, 'accepted risk')} are excluded` : '';
    sentences.push(`The Defense Score for these filters is ${Math.round(ds.score)}%${raw}.`);
  }
  return sentences;
}
