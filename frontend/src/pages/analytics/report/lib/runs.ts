// Helpers over the report's runs, shared by the test pages, the execution log
// and the run-strip appendix.
import type { OutcomeCounts, ReportAlert, ReportRun, ReportRunStage, ReportTest } from '@/services/api/reports';
import { truncate } from './format';
import { emptyCounts } from './outcomes';

/** Longest stage name printed beside a stage label in an alert row. */
const STAGE_NAME_MAX = 34;

export function countStages(stages: ReportRunStage[]): OutcomeCounts {
  const c = emptyCounts();
  for (const s of stages) c[s.outcome] += 1;
  return c;
}

export function firstAlert(run: ReportRun): ReportAlert | null {
  return run.alerts.reduce<ReportAlert | null>((best, a) => (best === null || a.createdAt < best.createdAt ? a : best), null);
}

export function vendorName(vendor: ReportAlert['vendor']): string {
  return vendor === 'defender' ? 'Defender' : 'Falcon';
}

/**
 * The stage of `run` that an alert's evidence names, or null for a bundle-level alert. The token is
 * the backend's lowercased control id, optionally with a variant suffix (`t1211-cfapi`), so it is
 * compared case-insensitively against the stage's controlId; a bare prefix is not a match.
 */
export function stageForAlert(run: ReportRun, token: string | null): ReportRunStage | null {
  if (!token) return null;
  const wanted = token.toLowerCase();
  return run.stages.find((s) => {
    const id = s.controlId?.toLowerCase();
    return !!id && (wanted === id || wanted.startsWith(`${id}-`));
  }) ?? null;
}

export interface ResolvedRunStage {
  name: string;
  techniques: string[];
  tactics: string[];
}

/**
 * A run stage's name, techniques and tactics. Reports with more than 25 runs omit them from the
 * run stages, so a missing value is read from the same stage (testKey + controlId) of `tests`.
 * The name falls back to the controlId, then to "Stage N", so something is always printable.
 */
export function resolveRunStage(tests: ReportTest[], run: ReportRun, stage: ReportRunStage): ResolvedRunStage {
  const known = tests.find((t) => t.testKey === run.testKey)?.stages.find((s) => s.controlId === stage.controlId);
  return {
    name: stage.name ?? known?.name ?? stage.controlId ?? `Stage ${stage.order}`,
    techniques: stage.techniques ?? known?.techniques ?? [],
    tactics: stage.tactics ?? known?.tactics ?? [],
  };
}

/** "S2 Privileged credential access" for the stage an alert names, or "bundle" when it names none. */
export function alertStageText(tests: ReportTest[], run: ReportRun, token: string | null): string {
  const stage = stageForAlert(run, token);
  return stage ? `S${stage.order} ${truncate(resolveRunStage(tests, run, stage).name, STAGE_NAME_MAX)}` : 'bundle';
}
