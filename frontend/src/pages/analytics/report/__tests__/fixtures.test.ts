import { describe, it, expect } from 'vitest';
import { makeReport, makeRun } from './fixtures';

describe('report fixtures: default runs are coherent', () => {
  const { runs } = makeReport();

  it('starts every run at or before its completion', () => {
    for (const run of runs) {
      expect(Date.parse(run.startedAt as string)).toBeLessThanOrEqual(Date.parse(run.completedAt));
    }
  });

  it('keeps run 1 at the 12:41:06 start the later tests were traced against', () => {
    expect(runs[0].startedAt).toBe('2026-10-12T12:41:06.000Z');
    expect(runs[0].completedAt).toBe('2026-10-12T12:47:49.000Z');
  });

  it('puts the run hostname and completion epoch in its key', () => {
    for (const run of runs) {
      expect(run.key).toContain(`::${run.hostname}::`);
      expect(run.key.endsWith(`::${Date.parse(run.completedAt)}`)).toBe(true);
    }
  });

  it('gives each run its own task id', () => {
    expect(new Set(runs.map((r) => r.taskId)).size).toBe(runs.length);
  });
});

describe('makeRun overrides', () => {
  it('lets an explicit null startedAt win over the derived start', () => {
    expect(makeRun({ startedAt: null }).startedAt).toBeNull();
  });

  it('lets an explicit startedAt win over the derived start', () => {
    expect(makeRun({ startedAt: '2026-10-12T12:00:00.000Z' }).startedAt).toBe('2026-10-12T12:00:00.000Z');
  });
});
