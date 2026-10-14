// Outcome vocabulary for the execution report (spec §5.1). Mirrors the
// console: Protected / Prevented / Detected / Unprotected / Inconclusive;
// Skipped stages are not results.
import type { OutcomeCounts, StageOutcome } from '@/services/api/reports';

/** Same threshold as the backend's RUN_STRIP_MAX_RUNS. */
export const RUN_STRIP_MAX_RUNS = 25;

const ALL_OUTCOMES: readonly StageOutcome[] = ['protected', 'prevented', 'detected', 'unprotected', 'inconclusive', 'skipped'];

/** Outcomes shown in bars and legends, best to worst, then no-verdict. */
export const COUNTED_OUTCOMES: readonly StageOutcome[] = ['protected', 'prevented', 'detected', 'unprotected', 'inconclusive'];

export const OUTCOME_LABEL: Record<StageOutcome, string> = {
  protected: 'Protected',
  prevented: 'Prevented',
  detected: 'Detected',
  unprotected: 'Unprotected',
  inconclusive: 'Inconclusive',
  skipped: 'Skipped',
};

export function emptyCounts(): OutcomeCounts {
  return { protected: 0, prevented: 0, detected: 0, unprotected: 0, inconclusive: 0, skipped: 0 };
}

export function sumCounts(list: OutcomeCounts[]): OutcomeCounts {
  const out = emptyCounts();
  for (const c of list) for (const k of ALL_OUTCOMES) out[k] += c[k];
  return out;
}

export function conclusive(c: OutcomeCounts): number {
  return c.protected + c.prevented + c.detected + c.unprotected;
}

export function defended(c: OutcomeCounts): number {
  return c.protected + c.prevented + c.detected;
}

/** Stage protection rate: defended ÷ conclusive. null when nothing reached a verdict. */
export function protectionRate(c: OutcomeCounts): number | null {
  const n = conclusive(c);
  return n === 0 ? null : defended(c) / n;
}

export type Band = 'held' | 'partial' | 'gap' | 'none';

export const BAND_LABEL: Record<Band, string> = { held: 'Held', partial: 'Partial', gap: 'Gap', none: 'No verdict' };

export function bandOf(rate: number | null): Band {
  if (rate === null) return 'none';
  if (rate >= 0.75) return 'held';
  if (rate >= 0.4) return 'partial';
  return 'gap';
}

/** DESIGN.md Status Rule: color is doubled by shape. */
export function shapeOf(outcome: StageOutcome): 'square' | 'circle' | 'hollow' {
  if (outcome === 'unprotected') return 'circle';
  if (outcome === 'inconclusive' || outcome === 'skipped') return 'hollow';
  return 'square';
}

const TACTIC_WORDS: Record<string, string> = { and: 'and' };

/** 'command-and-control' → 'Command and Control'. Non-kebab values pass through. */
export function tacticLabel(value: string): string {
  if (!value.includes('-')) return value;
  return value
    .split('-')
    .map((w) => TACTIC_WORDS[w] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
