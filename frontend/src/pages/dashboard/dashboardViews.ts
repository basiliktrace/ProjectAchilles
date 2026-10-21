import type {
  ExecutionActivityDay,
  ExecutionActivityResponse,
  TechniqueOutcomeItem,
  ThreatActorCoverageItem,
} from '@/services/api/analytics';
import type { AgentMetrics, Schedule } from '@/types/agent';
import type { TestMetadata } from '@/types/test';
import { tacticsForTechnique } from '@/lib/attack';
import { ENTERPRISE_TACTICS } from '@/lib/mitreTactics';

/* ------------------------------------------------------------------ */
/* Testing cadence                                                     */
/* ------------------------------------------------------------------ */

export interface CadenceView {
  /** One bar per UTC day, oldest first. */
  bars: ExecutionActivityDay[];
  /** True when the window has no results at all. */
  noRuns: boolean;
  /** Whole days since the last result; null when there has never been one. */
  lastRunDaysAgo: number | null;
  /** ISO time of the last result (all-time); null = never. */
  lastRunAt: string | null;
  executions7d: number;
  /** null = no conclusive results in the last 7 days. */
  protectedPct7d: number | null;
  endpointsTested7d: number;
  /** Enrolled agents. */
  agentsTotal: number;
  /** Agent task activity over the last 24h; null when metrics are unavailable. */
  tasks24h: { completed: number; failed: number; inProgress: number } | null;
  /** Earliest upcoming schedule; null when none or schedules unavailable. */
  nextScheduled: { when: string; label: string; endpoints: number } | null;
}

const MS_PER_DAY = 86_400_000;

export function buildCadence(
  activity: ExecutionActivityResponse,
  metrics: AgentMetrics | null,
  schedules: Schedule[] | null,
  agentsTotal: number,
  now: number = Date.now(),
): CadenceView {
  const bars = activity.days ?? [];
  const noRuns = activity.lastExecutionAt == null && bars.every(
    (d) => d.protected + d.unprotected + d.inconclusive === 0,
  );

  let lastRunDaysAgo: number | null = null;
  if (activity.lastExecutionAt) {
    const t = new Date(activity.lastExecutionAt).getTime();
    if (!Number.isNaN(t)) lastRunDaysAgo = Math.max(0, Math.floor((now - t) / MS_PER_DAY));
  }

  const act = metrics?.task_activity_24h;
  const tasks24h = act
    ? { completed: act.completed ?? 0, failed: act.failed ?? 0, inProgress: act.in_progress ?? 0 }
    : null;

  let nextScheduled: CadenceView['nextScheduled'] = null;
  for (const s of schedules ?? []) {
    if (!s.next_run_at) continue;
    const t = new Date(s.next_run_at).getTime();
    if (Number.isNaN(t)) continue;
    if (!nextScheduled || t < new Date(nextScheduled.when).getTime()) {
      nextScheduled = {
        when: s.next_run_at,
        label: s.name ?? s.test_name,
        endpoints: s.agent_ids?.length ?? 0,
      };
    }
  }

  return {
    bars,
    noRuns,
    lastRunDaysAgo,
    lastRunAt: lastRunDaysAgo == null ? null : activity.lastExecutionAt,
    executions7d: activity.executions7d ?? 0,
    protectedPct7d:
      activity.protectedPct7d != null && Number.isFinite(activity.protectedPct7d)
        ? activity.protectedPct7d
        : null,
    endpointsTested7d: activity.endpointsTested7d ?? 0,
    agentsTotal,
    tasks24h,
    nextScheduled,
  };
}

/* ------------------------------------------------------------------ */
/* Threat actor readiness                                              */
/* ------------------------------------------------------------------ */

export const ACTOR_ROW_LIMIT = 7;
export const ACTOR_EXPOSED_BELOW = 80;

export interface ActorRow {
  threatActor: string;
  /** Combined score 0-100. */
  score: number;
  pairCount: number;
  testCount: number;
  /** score < ACTOR_EXPOSED_BELOW */
  exposed: boolean;
  lastTestedAt: string | null;
}

export interface ActorReadinessView {
  /** Weakest first (score asc, pairs desc), at most ACTOR_ROW_LIMIT. */
  rows: ActorRow[];
  /** Actors with coverage data (before the row limit). */
  totalActors: number;
  /** Actors scoring below ACTOR_EXPOSED_BELOW (before the row limit). */
  exposedCount: number;
  /** Intel-driven library actors with no coverage in the range, sorted. */
  untestedActors: string[];
  /** Human range label, e.g. "30 days"; used for "not tested in <range>". */
  rangeLabel: string;
  /** Nothing to show: no coverage rows and no untested library actors. */
  empty: boolean;
}

export function buildActorReadiness(
  coverage: ThreatActorCoverageItem[],
  tests: TestMetadata[],
  rangeLabel = 'this range',
): ActorReadinessView {
  const pairs = (c: ThreatActorCoverageItem) => c.pairCount ?? c.totalExecutions ?? 0;
  const sorted = [...coverage].sort(
    (a, b) => a.coverage - b.coverage || pairs(b) - pairs(a) || a.threatActor.localeCompare(b.threatActor),
  );
  const rows: ActorRow[] = sorted.slice(0, ACTOR_ROW_LIMIT).map((c) => ({
    threatActor: c.threatActor,
    score: c.coverage,
    pairCount: pairs(c),
    testCount: c.testCount,
    exposed: c.coverage < ACTOR_EXPOSED_BELOW,
    lastTestedAt: c.lastTestedAt ?? null,
  }));

  const tested = new Set(coverage.map((c) => c.threatActor));
  const libraryActors = new Set<string>();
  for (const t of tests) {
    if (t.category === 'intel-driven' && t.threatActor) libraryActors.add(t.threatActor);
  }
  const untestedActors = [...libraryActors].filter((a) => !tested.has(a)).sort((a, b) => a.localeCompare(b));

  return {
    rows,
    totalActors: coverage.length,
    exposedCount: coverage.filter((c) => c.coverage < ACTOR_EXPOSED_BELOW).length,
    untestedActors,
    rangeLabel,
    empty: coverage.length === 0 && untestedActors.length === 0,
  };
}

/* ------------------------------------------------------------------ */
/* ATT&CK outcome matrix                                               */
/* ------------------------------------------------------------------ */

export type CellState = 'through' | 'detected' | 'protected' | 'notRun';

export interface MatrixCell {
  /** Exact technique ID as reported (sub-techniques are their own cells). */
  technique: string;
  state: CellState;
}

export interface MatrixColumn {
  slug: string;
  code: string;
  name: string;
  cells: MatrixCell[];
  /** Cells in the 'through' state. */
  throughCount: number;
}

export interface AttackMatrixView {
  /** One column per shown tactic (IA to IM), in kill-chain order. */
  columns: MatrixColumn[];
  /** Distinct techniques per state, each counted once (incl. unplaced ones). */
  totals: Record<CellState, number> & { techniques: number };
  /** Shown tactic with the most 'through' cells; null when none. */
  weakestTactic: { slug: string; code: string; name: string; throughCount: number } | null;
  /** No techniques in the outcomes or the library. */
  empty: boolean;
}

const STATE_ORDER: Record<CellState, number> = { through: 0, detected: 1, protected: 2, notRun: 3 };

function stateOf(o: { protected: number; detected: number; unprotected: number }): CellState {
  if (o.unprotected > 0) return 'through';
  if (o.detected > 0) return 'detected';
  return 'protected';
}

export function buildAttackMatrix(
  outcomes: TechniqueOutcomeItem[],
  tests: TestMetadata[],
): AttackMatrixView {
  const states = new Map<string, CellState>();
  for (const o of outcomes) {
    const next = stateOf(o);
    const prev = states.get(o.technique);
    // Same ID reported twice: keep the worst
    if (!prev || STATE_ORDER[next] < STATE_ORDER[prev]) states.set(o.technique, next);
  }
  for (const t of tests) {
    const ids = [...(t.techniques ?? []), ...(t.stages ?? []).map((s) => s.technique)];
    for (const id of ids) {
      if (id && !states.has(id)) states.set(id, 'notRun');
    }
  }

  const shown = ENTERPRISE_TACTICS.filter((t) => t.shown);
  const shownSlugs = new Set(shown.map((t) => t.slug));
  const byTactic = new Map<string, MatrixCell[]>(shown.map((t) => [t.slug, []]));
  const totals = { through: 0, detected: 0, protected: 0, notRun: 0, techniques: 0 };

  for (const [technique, state] of states) {
    totals[state] += 1;
    totals.techniques += 1;
    for (const slug of tacticsForTechnique(technique)) {
      if (shownSlugs.has(slug)) byTactic.get(slug)!.push({ technique, state });
    }
  }

  const columns: MatrixColumn[] = shown.map((t) => {
    const cells = byTactic.get(t.slug)!.sort(
      (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.technique.localeCompare(b.technique),
    );
    return {
      slug: t.slug,
      code: t.code,
      name: t.name,
      cells,
      throughCount: cells.filter((c) => c.state === 'through').length,
    };
  });

  let weakest: MatrixColumn | null = null;
  for (const c of columns) {
    if (c.throughCount > 0 && (!weakest || c.throughCount > weakest.throughCount)) weakest = c;
  }

  return {
    columns,
    totals,
    weakestTactic: weakest
      ? { slug: weakest.slug, code: weakest.code, name: weakest.name, throughCount: weakest.throughCount }
      : null,
    empty: states.size === 0,
  };
}
