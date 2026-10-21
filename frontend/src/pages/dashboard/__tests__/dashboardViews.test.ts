import { describe, it, expect } from 'vitest';
import { buildActorReadiness, buildAttackMatrix, buildCadence } from '../dashboardViews';
import type { ExecutionActivityResponse } from '@/services/api/analytics';
import type { AgentMetrics, Schedule } from '@/types/agent';
import type { TestMetadata } from '@/types/test';

function makeTest(o: Partial<TestMetadata>): TestMetadata {
  return { uuid: crypto.randomUUID(), name: 't', techniques: [], isMultiStage: false, stages: [], ...o };
}
const NOW = Date.parse('2026-10-20T12:00:00Z');
const day = (date: string, p = 0, u = 0, i = 0) => ({ date, protected: p, unprotected: u, inconclusive: i });
const metrics = {
  total: 10,
  task_activity_24h: { completed: 5, failed: 1, total: 7, success_rate: 83, in_progress: 1 },
} as AgentMetrics;
const sched = (o: Partial<Schedule>) => ({ name: null, test_name: 'Test', agent_ids: ['a'], next_run_at: null, ...o }) as Schedule;

describe('buildCadence', () => {
  it('computes bars, last run days-ago, tasks and next schedule', () => {
    const activity: ExecutionActivityResponse = {
      days: [day('2026-10-19', 3, 1, 0), day('2026-10-20')],
      lastExecutionAt: '2026-10-17T11:00:00Z',
      executions7d: 4,
      protectedPct7d: 75,
      endpointsTested7d: 2,
    };
    const v = buildCadence(activity, metrics, [
      sched({ next_run_at: '2026-10-23T09:00:00Z', name: 'Late' }),
      sched({ next_run_at: '2026-10-21T09:00:00Z', agent_ids: ['a', 'b'] }),
      sched({ next_run_at: null }),
    ], 10, NOW);
    expect(v.noRuns).toBe(false);
    expect(v.lastRunDaysAgo).toBe(3);
    expect(v.protectedPct7d).toBe(75);
    expect(v.tasks24h).toEqual({ completed: 5, failed: 1, inProgress: 1 });
    expect(v.nextScheduled).toEqual({ when: '2026-10-21T09:00:00Z', label: 'Test', endpoints: 2 });
    expect(v.agentsTotal).toBe(10);
  });

  it('zero runs and null lastExecutionAt gives an explicit no-runs state without NaN', () => {
    const v = buildCadence(
      { days: [day('2026-10-19'), day('2026-10-20')], lastExecutionAt: null, executions7d: 0, protectedPct7d: null, endpointsTested7d: 0 },
      null, [], 0, NOW,
    );
    expect(v.noRuns).toBe(true);
    expect(v.lastRunDaysAgo).toBeNull();
    expect(v.protectedPct7d).toBeNull();
    expect(v.tasks24h).toBeNull();
    expect(JSON.stringify(v)).not.toContain('NaN');
  });

  it('null schedules (403) or none dated gives nextScheduled null', () => {
    const a: ExecutionActivityResponse = { days: [], lastExecutionAt: null, executions7d: 0, protectedPct7d: null, endpointsTested7d: 0 };
    expect(buildCadence(a, metrics, null, 1, NOW).nextScheduled).toBeNull();
    expect(buildCadence(a, metrics, [sched({})], 1, NOW).nextScheduled).toBeNull();
  });

  it('is not "no runs" when an old run exists but the window is empty', () => {
    const v = buildCadence(
      { days: [day('2026-10-20')], lastExecutionAt: '2026-08-01T00:00:00Z', executions7d: 0, protectedPct7d: null, endpointsTested7d: 0 },
      metrics, null, 1, NOW,
    );
    expect(v.noRuns).toBe(false);
    expect(v.lastRunDaysAgo).toBe(80);
  });
});

describe('buildActorReadiness', () => {
  it('no actors in data or library gives empty rows and the empty flag', () => {
    const v = buildActorReadiness([], [makeTest({ category: 'cyber-hygiene' })]);
    expect(v.rows).toEqual([]);
    expect(v.empty).toBe(true);
    expect(v.untestedActors).toEqual([]);
  });

  it('sorts by score asc then pairs desc, caps at 7, counts exposed and untested', () => {
    const cov = Array.from({ length: 9 }, (_, i) => ({
      threatActor: `A${i}`, coverage: i < 2 ? 50 : 70 + i * 3, testCount: 1, protectedCount: 1, totalExecutions: 5, pairCount: i === 1 ? 20 : 5,
    }));
    const tests = [
      makeTest({ category: 'intel-driven', threatActor: 'A0' }),
      makeTest({ category: 'intel-driven', threatActor: 'Zed' }),
      makeTest({ category: 'intel-driven', threatActor: 'Alpha' }),
      makeTest({ category: 'cyber-hygiene', threatActor: 'Other' }),
    ];
    const v = buildActorReadiness(cov, tests, 'the last 30d');
    expect(v.rows).toHaveLength(7);
    expect(v.rows[0].threatActor).toBe('A1');
    expect(v.rows[1].threatActor).toBe('A0');
    expect(v.rows[0].exposed).toBe(true);
    expect(v.totalActors).toBe(9);
    // 50,50,76,79,82,... -> exposed: 50,50,76,79
    expect(v.exposedCount).toBe(4);
    expect(v.untestedActors).toEqual(['Alpha', 'Zed']);
    expect(v.rangeLabel).toBe('the last 30d');
    expect(v.empty).toBe(false);
  });
});

describe('buildAttackMatrix', () => {
  const o = (technique: string, p = 0, d = 0, u = 0) => ({ technique, protected: p, detected: d, unprotected: u, lastTestedAt: '2026-10-20T00:00:00Z' });

  it('places sub-techniques under parent tactics; unknown IDs count in totals but in no column', () => {
    const v = buildAttackMatrix([o('T1059.001', 1), o('T9999', 0, 0, 2)], []);
    const exec = v.columns.find((c) => c.slug === 'execution')!;
    expect(exec.cells).toContainEqual({ technique: 'T1059.001', state: 'protected' });
    expect(v.columns.some((c) => c.cells.some((x) => x.technique === 'T9999'))).toBe(false);
    expect(v.totals.techniques).toBe(2);
    expect(v.totals.through).toBe(1);
    expect(v.empty).toBe(false);
  });

  it('worst state wins, library techniques without outcomes are notRun, ordering and weakest tactic', () => {
    const v = buildAttackMatrix(
      [o('T1059', 5, 0, 0), o('T1059.001', 3, 2, 0), o('T1059.003', 1, 0, 1), o('T1059.005', 1, 0, 1)],
      [makeTest({ techniques: ['T1059.007'], stages: [{ stageId: 1, technique: 'T1059.008', name: 's', fileName: 'f' }] })],
    );
    const exec = v.columns.find((c) => c.slug === 'execution')!;
    expect(exec.cells.map((c) => `${c.technique}:${c.state}`)).toEqual([
      'T1059.003:through', 'T1059.005:through', 'T1059.001:detected', 'T1059:protected',
      'T1059.007:notRun', 'T1059.008:notRun',
    ]);
    expect(exec.throughCount).toBe(2);
    expect(v.weakestTactic?.slug).toBe('execution');
    expect(v.totals).toMatchObject({ through: 2, detected: 1, protected: 1, notRun: 2, techniques: 6 });
  });

  it('no through cells gives weakestTactic null; nothing at all is empty', () => {
    expect(buildAttackMatrix([o('T1059', 1)], []).weakestTactic).toBeNull();
    const e = buildAttackMatrix([], []);
    expect(e.empty).toBe(true);
    expect(e.columns.length).toBeGreaterThan(0);
  });
});
