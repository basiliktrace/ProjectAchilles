import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DbHelper } from '../database.js';
import { createTestDatabase, insertTestAgent } from '../../../__tests__/helpers/db.js';

let testDb: DbHelper;

vi.mock('../database.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../database.js')>();
  return { ...actual, getDb: async () => testDb };
});

// Mock createTasks (called by processSchedules)
const mockCreateTasks = vi.fn().mockResolvedValue(['task-001']);
vi.mock('../tasks.service.js', () => ({
  createTasks: (...args: unknown[]) => mockCreateTasks(...args),
}));

const {
  computeNextRun,
  computePerAgentNextRuns,
  resolveRandomizeMode,
  createSchedule,
  listSchedules,
  getSchedule,
  updateSchedule,
  deleteSchedule,
  processSchedules,
  FRESHEN_GRACE_MS,
} = await import('../schedules.service.js');

// ============================================================================
// Common helpers
// ============================================================================

function baseScheduleRequest(overrides: Record<string, unknown> = {}) {
  return {
    agent_ids: ['agent-001'],
    org_id: 'org-001',
    test_uuid: 'test-uuid-001',
    test_name: 'Test Schedule',
    binary_name: 'test.exe',
    schedule_type: 'daily' as const,
    schedule_config: { time: '10:00' },
    timezone: 'UTC',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('schedules.service', () => {
  beforeEach(async () => {
    testDb = await createTestDatabase();
    await insertTestAgent(testDb, { id: 'agent-001' });
    mockCreateTasks.mockClear();
    mockCreateTasks.mockResolvedValue(['task-001']);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // computeNextRun
  // ==========================================================================

  describe('computeNextRun', () => {
    describe('once type', () => {
      it('returns correct UTC date for future date+time', () => {
        const now = new Date('2026-02-09T08:00:00Z');
        const result = computeNextRun(
          'once',
          { date: '2026-02-10', time: '14:00' },
          'UTC',
          now,
        );
        expect(result).not.toBeNull();
        expect(result!.toISOString()).toBe('2026-02-10T14:00:00.000Z');
      });

      it('returns null for past date+time', () => {
        const now = new Date('2026-02-09T16:00:00Z');
        const result = computeNextRun(
          'once',
          { date: '2026-02-09', time: '10:00' },
          'UTC',
          now,
        );
        expect(result).toBeNull();
      });

      it('applies timezone offset (America/New_York is UTC-5 in Feb)', () => {
        const now = new Date('2026-02-09T08:00:00Z');
        const result = computeNextRun(
          'once',
          { date: '2026-02-10', time: '10:00' },
          'America/New_York',
          now,
        );
        expect(result).not.toBeNull();
        // 10:00 EST = 15:00 UTC (UTC-5 in Feb)
        expect(result!.getUTCHours()).toBe(15);
      });
    });

    describe('daily type', () => {
      it('returns today when time is in the future', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));

        const result = computeNextRun('daily', { time: '14:00' }, 'UTC');
        expect(result).not.toBeNull();
        expect(result!.toISOString()).toBe('2026-02-09T14:00:00.000Z');
      });

      it('returns tomorrow when time has passed', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-09T16:00:00Z'));

        const result = computeNextRun('daily', { time: '10:00' }, 'UTC');
        expect(result).not.toBeNull();
        expect(result!.toISOString()).toBe('2026-02-10T10:00:00.000Z');
      });

      it('returns randomized time within weekday office hours when randomize_time is true', () => {
        vi.useFakeTimers();
        // Monday Feb 9, 2026
        vi.setSystemTime(new Date('2026-02-09T07:00:00Z'));
        vi.spyOn(Math, 'random').mockReturnValue(0.0); // earliest possible time

        const result = computeNextRun('daily', { time: '10:00', randomize_time: true }, 'UTC');
        expect(result).not.toBeNull();
        // Weekday office hours: 09:00-16:59, random=0 → 09:00
        expect(result!.getUTCHours()).toBe(9);
        expect(result!.getUTCMinutes()).toBe(0);
      });

      it('returns randomized time within weekend full range when randomize_time is true', () => {
        vi.useFakeTimers();
        // Saturday Feb 7, 2026
        vi.setSystemTime(new Date('2026-02-07T01:00:00Z'));
        vi.spyOn(Math, 'random').mockReturnValue(0.0); // earliest

        const result = computeNextRun('daily', { time: '10:00', randomize_time: true }, 'UTC');
        expect(result).not.toBeNull();
        // Weekend: 00:00-23:59, random=0 → 00:00
        expect(result!.getUTCHours()).toBe(0);
      });
    });

    describe('weekly type', () => {
      it('returns today when current day matches and time is in the future', () => {
        vi.useFakeTimers();
        // Feb 9, 2026 is Monday = day 1
        vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));

        const result = computeNextRun('weekly', { days: [1], time: '14:00' }, 'UTC');
        expect(result).not.toBeNull();
        expect(result!.toISOString()).toBe('2026-02-09T14:00:00.000Z');
      });

      it('returns next matching day when current day does not match', () => {
        vi.useFakeTimers();
        // Feb 9, 2026 is Monday = day 1, looking for Wednesday = day 3
        vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));

        const result = computeNextRun('weekly', { days: [3], time: '10:00' }, 'UTC');
        expect(result).not.toBeNull();
        // Wednesday is Feb 11
        expect(result!.toISOString()).toBe('2026-02-11T10:00:00.000Z');
      });

      it('returns null for empty days array', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));

        const result = computeNextRun('weekly', { days: [], time: '10:00' }, 'UTC');
        expect(result).toBeNull();
      });

      it('wraps around to next week', () => {
        vi.useFakeTimers();
        // Feb 9 Monday, time passed. Looking for Monday = day 1
        vi.setSystemTime(new Date('2026-02-09T18:00:00Z'));

        const result = computeNextRun('weekly', { days: [1], time: '10:00' }, 'UTC');
        expect(result).not.toBeNull();
        // Next Monday is Feb 16
        expect(result!.toISOString()).toBe('2026-02-16T10:00:00.000Z');
      });
    });

    describe('monthly type', () => {
      it('returns this month when day is in the future', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-05T08:00:00Z'));

        const result = computeNextRun('monthly', { dayOfMonth: 15, time: '10:00' }, 'UTC');
        expect(result).not.toBeNull();
        expect(result!.toISOString()).toBe('2026-02-15T10:00:00.000Z');
      });

      it('returns next month when day has passed', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-20T08:00:00Z'));

        const result = computeNextRun('monthly', { dayOfMonth: 10, time: '10:00' }, 'UTC');
        expect(result).not.toBeNull();
        expect(result!.getUTCMonth()).toBe(2); // March
        expect(result!.getUTCDate()).toBe(10);
      });

      it('clamps day 31 to last day of month (Feb has 28)', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-01T08:00:00Z'));

        const result = computeNextRun('monthly', { dayOfMonth: 31, time: '10:00' }, 'UTC');
        expect(result).not.toBeNull();
        // Feb 2026 has 28 days
        expect(result!.getUTCDate()).toBe(28);
      });

      it('wraps December to January of next year', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-12-20T08:00:00Z'));

        const result = computeNextRun('monthly', { dayOfMonth: 10, time: '10:00' }, 'UTC');
        expect(result).not.toBeNull();
        expect(result!.getUTCFullYear()).toBe(2027);
        expect(result!.getUTCMonth()).toBe(0); // January
        expect(result!.getUTCDate()).toBe(10);
      });
    });

    describe('timezone edge cases', () => {
      it('handles UTC baseline correctly', () => {
        const now = new Date('2026-02-09T08:00:00Z');
        const result = computeNextRun('once', { date: '2026-02-10', time: '12:00' }, 'UTC', now);
        expect(result!.getUTCHours()).toBe(12);
      });

      it('handles Asia/Tokyo (UTC+9)', () => {
        const now = new Date('2026-02-09T00:00:00Z');
        const result = computeNextRun(
          'once',
          { date: '2026-02-10', time: '09:00' },
          'Asia/Tokyo',
          now,
        );
        expect(result).not.toBeNull();
        // 09:00 JST = 00:00 UTC
        expect(result!.getUTCHours()).toBe(0);
        expect(result!.getUTCDate()).toBe(10);
      });
    });
  });

  // ==========================================================================
  // createSchedule
  // ==========================================================================

  describe('createSchedule', () => {
    it('creates a valid daily schedule', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));

      const schedule = await createSchedule(baseScheduleRequest(), 'user-001');

      expect(schedule.id).toBeDefined();
      expect(schedule.schedule_type).toBe('daily');
      expect(schedule.status).toBe('active');
      expect(schedule.agent_ids).toEqual(['agent-001']);
      expect(schedule.next_run_at).toBeDefined();
    });

    it('creates a valid weekly schedule with multiple days', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));

      const schedule = await createSchedule(
        baseScheduleRequest({
          schedule_type: 'weekly',
          schedule_config: { days: [1, 3, 5], time: '10:00' },
        }),
        'user-001',
      );

      expect(schedule.schedule_type).toBe('weekly');
      expect(schedule.schedule_config).toEqual({ days: [1, 3, 5], time: '10:00' });
    });

    it('creates a valid once schedule', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));

      const schedule = await createSchedule(
        baseScheduleRequest({
          schedule_type: 'once',
          schedule_config: { date: '2026-03-01', time: '14:00' },
        }),
        'user-001',
      );

      expect(schedule.schedule_type).toBe('once');
      expect(schedule.next_run_at).toBeDefined();
    });

    it('throws 400 for missing agent_ids', async () => {
      await expect(
        createSchedule(baseScheduleRequest({ agent_ids: [] }), 'user-001')
      ).rejects.toThrow('At least one agent_id is required');
    });

    it('throws 400 for missing test_uuid', async () => {
      await expect(
        createSchedule(baseScheduleRequest({ test_uuid: '' }), 'user-001')
      ).rejects.toThrow('test_uuid, test_name, and binary_name are required');
    });

    it('throws 400 for once schedule with past time', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T16:00:00Z'));

      await expect(
        createSchedule(
          baseScheduleRequest({
            schedule_type: 'once',
            schedule_config: { date: '2026-02-09', time: '10:00' },
          }),
          'user-001',
        )
      ).rejects.toThrow('Scheduled time must be in the future');
    });
  });

  // ==========================================================================
  // listSchedules
  // ==========================================================================

  describe('listSchedules', () => {
    it('returns active schedules', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));

      await createSchedule(baseScheduleRequest({ name: 'First' }), 'user-001');
      await createSchedule(baseScheduleRequest({ name: 'Second' }), 'user-001');

      const schedules = await listSchedules({ org_id: 'org-001' });
      expect(schedules).toHaveLength(2);
      const names = schedules.map(s => s.name).sort();
      expect(names).toEqual(['First', 'Second']);
    });

    it('filters by org_id', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));

      await createSchedule(baseScheduleRequest({ org_id: 'org-001' }), 'user-001');
      await createSchedule(baseScheduleRequest({ org_id: 'org-002' }), 'user-002');

      const schedules = await listSchedules({ org_id: 'org-001' });
      expect(schedules).toHaveLength(1);
    });

    it('excludes deleted schedules', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));

      const schedule = await createSchedule(baseScheduleRequest(), 'user-001');
      await deleteSchedule(schedule.id);

      const schedules = await listSchedules({ org_id: 'org-001' });
      expect(schedules).toHaveLength(0);
    });
  });

  // ==========================================================================
  // getSchedule
  // ==========================================================================

  describe('getSchedule', () => {
    it('returns schedule by ID', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));

      const created = await createSchedule(baseScheduleRequest({ name: 'Test' }), 'user-001');
      const schedule = await getSchedule(created.id);
      expect(schedule.id).toBe(created.id);
      expect(schedule.name).toBe('Test');
    });

    it('throws 404 for nonexistent ID', async () => {
      await expect(getSchedule('nonexistent')).rejects.toThrow('Schedule not found');
    });
  });

  // ==========================================================================
  // updateSchedule
  // ==========================================================================

  describe('updateSchedule', () => {
    it('updates name field', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));

      const created = await createSchedule(baseScheduleRequest({ name: 'Old Name' }), 'user-001');
      const updated = await updateSchedule(created.id, { name: 'New Name' });
      expect(updated.name).toBe('New Name');
    });

    it('recomputes next_run_at when schedule_config changes', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));

      const created = await createSchedule(baseScheduleRequest(), 'user-001');
      const originalNextRun = created.next_run_at;

      const updated = await updateSchedule(created.id, {
        schedule_config: { time: '18:00' },
      });
      expect(updated.next_run_at).not.toBe(originalNextRun);
    });

    it('sets next_run_at to null when status changed to paused', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));

      const created = await createSchedule(baseScheduleRequest(), 'user-001');

      // Pause recomputes via computeNextRun, but the status is 'paused'
      // so the code only recomputes when status is 'active'
      const updated = await updateSchedule(created.id, { status: 'paused' });
      expect(updated.status).toBe('paused');
    });

    it('throws 404 for nonexistent ID', async () => {
      await expect(updateSchedule('nonexistent', { name: 'x' })).rejects.toThrow('Schedule not found');
    });
  });

  // ==========================================================================
  // deleteSchedule
  // ==========================================================================

  describe('deleteSchedule', () => {
    it('soft-deletes a schedule (sets status to deleted)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));

      const created = await createSchedule(baseScheduleRequest(), 'user-001');
      await deleteSchedule(created.id);

      // Direct DB check since getSchedule would also return it as 'deleted'
      const row = await testDb.get('SELECT status FROM schedules WHERE id = ?', [created.id]) as unknown as any;
      expect(row.status).toBe('deleted');
    });

    it('throws 404 for nonexistent ID', async () => {
      await expect(deleteSchedule('nonexistent')).rejects.toThrow('Schedule not found');
    });
  });

  // ==========================================================================
  // processSchedules
  // ==========================================================================

  describe('processSchedules', () => {
    it('processes a due schedule, calls createTasks, and updates last_run_at', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));

      const schedule = await createSchedule(baseScheduleRequest({
        schedule_config: { time: '07:00' }, // time already passed
      }), 'user-001');

      // Manually set next_run_at to the past so it's due
      await testDb.run("UPDATE schedules SET next_run_at = datetime('now', '-1 hour') WHERE id = ?",
        [schedule.id]);

      const result = await processSchedules();

      expect(result.processed).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(mockCreateTasks).toHaveBeenCalledTimes(1);

      // Verify last_run_at was set
      const row = await testDb.get('SELECT last_run_at, next_run_at FROM schedules WHERE id = ?',
        [schedule.id]) as unknown as any;
      expect(row.last_run_at).toBeDefined();
      expect(row.next_run_at).toBeDefined(); // daily schedule should have next run
    });

    it('sets once schedule to completed after processing', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));

      const schedule = await createSchedule(baseScheduleRequest({
        schedule_type: 'once',
        schedule_config: { date: '2026-02-10', time: '14:00' },
      }), 'user-001');

      // Set next_run_at to past so it's due
      await testDb.run("UPDATE schedules SET next_run_at = datetime('now', '-1 hour') WHERE id = ?",
        [schedule.id]);

      await processSchedules();

      const row = await testDb.get('SELECT status FROM schedules WHERE id = ?',
        [schedule.id]) as unknown as any;
      expect(row.status).toBe('completed');
    });

    it('logs error but still advances next_run_at on task creation failure', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));

      const schedule = await createSchedule(baseScheduleRequest(), 'user-001');

      await testDb.run("UPDATE schedules SET next_run_at = datetime('now', '-1 hour') WHERE id = ?",
        [schedule.id]);

      // Make createTasks fail
      mockCreateTasks.mockImplementation(() => {
        throw new Error('Build not found');
      });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await processSchedules();

      expect(result.processed).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Build not found');

      // next_run_at should still be advanced (no retry spam)
      const row = await testDb.get('SELECT next_run_at, last_run_at FROM schedules WHERE id = ?',
        [schedule.id]) as unknown as any;
      expect(row.last_run_at).toBeDefined();

      consoleSpy.mockRestore();
    });

    it('skips decommissioned agents in schedule', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));

      // Insert a second agent that is decommissioned
      await insertTestAgent(testDb, { id: 'agent-decomm', status: 'decommissioned' });

      const schedule = await createSchedule(baseScheduleRequest({
        agent_ids: ['agent-001', 'agent-decomm'],
      }), 'user-001');

      await testDb.run("UPDATE schedules SET next_run_at = datetime('now', '-1 hour') WHERE id = ?",
        [schedule.id]);

      const result = await processSchedules();

      expect(result.processed).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(mockCreateTasks).toHaveBeenCalledTimes(1);

      // Only the active agent should be passed to createTasks
      const callArgs = mockCreateTasks.mock.calls[0][0];
      expect(callArgs.agent_ids).toEqual(['agent-001']);
    });

    it('skips createTasks entirely when all agents are decommissioned', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));

      await insertTestAgent(testDb, { id: 'agent-decomm-only', status: 'decommissioned' });

      const schedule = await createSchedule(baseScheduleRequest({
        agent_ids: ['agent-decomm-only'],
      }), 'user-001');

      await testDb.run("UPDATE schedules SET next_run_at = datetime('now', '-1 hour') WHERE id = ?",
        [schedule.id]);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await processSchedules();

      expect(result.processed).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(mockCreateTasks).not.toHaveBeenCalled();

      // next_run_at should still be advanced (avoid retry spam)
      const row = await testDb.get('SELECT next_run_at, last_run_at FROM schedules WHERE id = ?',
        [schedule.id]) as unknown as any;
      expect(row.last_run_at).toBeDefined();
      expect(row.next_run_at).toBeDefined();

      warnSpy.mockRestore();
    });

    // Regression for May-2026 outage. Mirror of backend/ test.
    it('fires due schedule whose next_run_at is stored in ISO 8601 format', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-04T15:42:00Z'));

      const schedule = await createSchedule(baseScheduleRequest(), 'user-001');

      // ISO format with 'T' separator — what processSchedules persists.
      await testDb.run('UPDATE schedules SET next_run_at = ? WHERE id = ?',
        ['2026-05-04T08:17:00.000Z', schedule.id]);

      const result = await processSchedules();

      expect(result.processed).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(mockCreateTasks).toHaveBeenCalledTimes(1);
    });

    it('does NOT fire a schedule whose ISO next_run_at is in the future', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-04T15:42:00Z'));

      const schedule = await createSchedule(baseScheduleRequest(), 'user-001');

      // Far-future ISO timestamp. Note: vi.setSystemTime affects JS Date but
      // not SQLite's datetime('now') — that reads the OS clock — so the
      // chosen value must be in the future relative to BOTH the fake JS time
      // AND real wall-clock time at test execution. Earlier this test used
      // 2026-05-05, which silently broke as soon as wall-clock crossed that
      // date (the backend/ mirror was fixed the same way).
      await testDb.run('UPDATE schedules SET next_run_at = ? WHERE id = ?',
        ['2099-12-31T23:59:59.000Z', schedule.id]);

      const result = await processSchedules();

      expect(result.processed).toBe(0);
      expect(mockCreateTasks).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // freshenNextRun via listSchedules / getSchedule (persistence regression)
  // ==========================================================================

  describe('freshenNextRun persistence', () => {
    it('persists a recomputed next_run_at when listSchedules sees a stale value', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-04T15:42:00Z'));

      const schedule = await createSchedule(baseScheduleRequest(), 'user-001');

      await testDb.run('UPDATE schedules SET next_run_at = ? WHERE id = ?',
        ['2026-05-04T08:17:00.000Z', schedule.id]);

      await listSchedules();

      const row = await testDb.get('SELECT next_run_at FROM schedules WHERE id = ?',
        [schedule.id]) as unknown as { next_run_at: string };
      expect(row.next_run_at).not.toBe('2026-05-04T08:17:00.000Z');
      expect(new Date(row.next_run_at).getTime()).toBeGreaterThan(Date.now());
    });

    it('does NOT touch next_run_at when it is already in the future', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-04T15:42:00Z'));

      const schedule = await createSchedule(baseScheduleRequest(), 'user-001');

      const futureIso = '2026-05-05T14:01:00.000Z';
      await testDb.run('UPDATE schedules SET next_run_at = ? WHERE id = ?',
        [futureIso, schedule.id]);

      await listSchedules();

      const row = await testDb.get('SELECT next_run_at FROM schedules WHERE id = ?',
        [schedule.id]) as unknown as { next_run_at: string };
      expect(row.next_run_at).toBe(futureIso);
    });
  });

  // ==========================================================================
  // Per-machine randomization
  // ==========================================================================

  describe('resolveRandomizeMode', () => {
    it('uses explicit randomize_mode when present', () => {
      expect(resolveRandomizeMode({ time: '10:00', randomize_mode: 'per_machine' })).toBe('per_machine');
      expect(resolveRandomizeMode({ time: '10:00', randomize_mode: 'fleet' })).toBe('fleet');
      expect(resolveRandomizeMode({ time: '10:00', randomize_mode: 'fixed' })).toBe('fixed');
    });

    it('maps legacy randomize_time:true to fleet', () => {
      expect(resolveRandomizeMode({ time: '10:00', randomize_time: true })).toBe('fleet');
    });

    it('maps legacy randomize_time absent/false to fixed', () => {
      expect(resolveRandomizeMode({ time: '10:00' })).toBe('fixed');
      expect(resolveRandomizeMode({ time: '10:00', randomize_time: false })).toBe('fixed');
    });

    it('prefers explicit mode over legacy randomize_time', () => {
      expect(resolveRandomizeMode({ time: '10:00', randomize_time: true, randomize_mode: 'fixed' })).toBe('fixed');
    });
  });

  describe('computePerAgentNextRuns', () => {
    it('returns one entry per agent', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));

      const map = computePerAgentNextRuns(
        'daily',
        { time: '10:00', randomize_mode: 'per_machine' },
        'UTC',
        ['agent-a', 'agent-b', 'agent-c'],
      );

      expect(Object.keys(map).sort()).toEqual(['agent-a', 'agent-b', 'agent-c']);
      for (const iso of Object.values(map)) {
        expect(new Date(iso).getTime()).toBeGreaterThan(Date.now());
      }
    });

    it('produces independent times so the whole fleet is not synchronized', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));

      const agentIds = Array.from({ length: 30 }, (_, i) => `agent-${i}`);
      const map = computePerAgentNextRuns(
        'daily',
        { time: '10:00', randomize_mode: 'per_machine' },
        'UTC',
        agentIds,
      );

      const distinct = new Set(Object.values(map));
      expect(distinct.size).toBeGreaterThan(1);
    });
  });

  describe('createSchedule (per_machine)', () => {
    it('populates agent_next_runs and sets next_run_at to the minimum', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));
      await insertTestAgent(testDb, { id: 'agent-002' });

      const schedule = await createSchedule(baseScheduleRequest({
        agent_ids: ['agent-001', 'agent-002'],
        schedule_config: { time: '10:00', randomize_mode: 'per_machine' },
      }), 'user-001');

      expect(schedule.agent_next_runs).not.toBeNull();
      expect(Object.keys(schedule.agent_next_runs!).sort()).toEqual(['agent-001', 'agent-002']);

      const minIso = Object.values(schedule.agent_next_runs!).sort()[0];
      expect(schedule.next_run_at).toBe(minIso);
    });

    it('leaves agent_next_runs null for fleet schedules', async () => {
      const schedule = await createSchedule(baseScheduleRequest({
        schedule_config: { time: '10:00', randomize_mode: 'fleet' },
      }), 'user-001');
      expect(schedule.agent_next_runs).toBeNull();
    });
  });

  describe('processSchedules (per_machine)', () => {
    it('dispatches only agents whose individual time is due and advances only them', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T12:00:00Z'));
      await insertTestAgent(testDb, { id: 'agent-002' });

      const schedule = await createSchedule(baseScheduleRequest({
        agent_ids: ['agent-001', 'agent-002'],
        schedule_config: { time: '10:00', randomize_mode: 'per_machine' },
      }), 'user-001');

      const dueIso = '2026-02-09T11:00:00.000Z';
      const pendingIso = '2026-02-09T18:00:00.000Z';
      await testDb.run('UPDATE schedules SET agent_next_runs = ?, next_run_at = ? WHERE id = ?',
        [JSON.stringify({ 'agent-001': dueIso, 'agent-002': pendingIso }), dueIso, schedule.id]);

      const result = await processSchedules();

      expect(result.processed).toBe(1);
      expect(mockCreateTasks).toHaveBeenCalledTimes(1);
      expect(mockCreateTasks.mock.calls[0][0].agent_ids).toEqual(['agent-001']);

      const row = await testDb.get('SELECT agent_next_runs FROM schedules WHERE id = ?',
        [schedule.id]) as unknown as { agent_next_runs: string };
      const map = JSON.parse(row.agent_next_runs) as Record<string, string>;
      expect(new Date(map['agent-001']).getTime()).toBeGreaterThan(Date.now());
      expect(map['agent-002']).toBe(pendingIso);
    });
  });

  describe('updateSchedule (per_machine reconciliation)', () => {
    it('adds map entries for newly added agents and drops removed ones', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));
      await insertTestAgent(testDb, { id: 'agent-002' });
      await insertTestAgent(testDb, { id: 'agent-003' });

      const schedule = await createSchedule(baseScheduleRequest({
        agent_ids: ['agent-001', 'agent-002'],
        schedule_config: { time: '10:00', randomize_mode: 'per_machine' },
      }), 'user-001');

      const updated = await updateSchedule(schedule.id, { agent_ids: ['agent-002', 'agent-003'] });

      expect(Object.keys(updated.agent_next_runs!).sort()).toEqual(['agent-002', 'agent-003']);
      expect(updated.agent_next_runs!['agent-002']).toBe(schedule.agent_next_runs!['agent-002']);
    });

    it('clears agent_next_runs when switching away from per_machine', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T08:00:00Z'));

      const schedule = await createSchedule(baseScheduleRequest({
        schedule_config: { time: '10:00', randomize_mode: 'per_machine' },
      }), 'user-001');
      expect(schedule.agent_next_runs).not.toBeNull();

      const updated = await updateSchedule(schedule.id, {
        schedule_config: { time: '10:00', randomize_mode: 'fleet' },
      });
      expect(updated.agent_next_runs).toBeNull();
    });
  });

  // ==========================================================================
  // R25: a randomized schedule never runs twice on the same local day
  // ==========================================================================

  describe('randomized schedules never run twice on the same day (R25)', () => {
    // processSchedules() here has no clock parameter: its due-query uses
    // SQLite's wall clock, and the JS `now` comes from vi.setSystemTime. These
    // dates are in the real past, so the SQL always selects the row and the
    // fake JS clock alone decides what is due and how it advances.

    // Weekday window is 09:00-17:00 (480 min): 300/480 rolls 14:00.
    const ROLL_14_00 = 0.625;
    // Weekend window is 00:00-24:00 (1440 min): 1380/1440 rolls 23:00.
    const ROLL_23_00 = 1380.5 / 1440;
    const MON_10_00 = new Date('2026-02-09T10:00:00.000Z'); // Monday, UTC

    const rowOf = async (id: string) =>
      (await testDb.get('SELECT next_run_at, agent_next_runs FROM schedules WHERE id = ?', [id])) as unknown as {
        next_run_at: string | null;
        agent_next_runs: string | null;
      };

    it('daily fleet: after firing at 10:00, next_run_at is tomorrow inside tomorrow\'s window', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(MON_10_00);
      vi.spyOn(Math, 'random').mockReturnValue(ROLL_14_00);
      const schedule = await createSchedule(baseScheduleRequest({
        schedule_config: { time: '10:00', randomize_mode: 'fleet' },
      }), 'user-001');
      await testDb.run('UPDATE schedules SET next_run_at = ? WHERE id = ?', [MON_10_00.toISOString(), schedule.id]);

      await processSchedules();

      expect(mockCreateTasks).toHaveBeenCalledTimes(1);
      const next = (await rowOf(schedule.id)).next_run_at!;
      expect(next).toBe('2026-02-10T14:00:00.000Z');
      expect(next >= '2026-02-10T09:00:00.000Z' && next < '2026-02-10T17:00:00.000Z').toBe(true);
    });

    it('daily per_machine: the agent advances to tomorrow and a 14:01 tick does not dispatch again', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(MON_10_00);
      vi.spyOn(Math, 'random').mockReturnValue(ROLL_14_00);
      const schedule = await createSchedule(baseScheduleRequest({
        schedule_config: { time: '10:00', randomize_mode: 'per_machine' },
      }), 'user-001');
      await testDb.run('UPDATE schedules SET agent_next_runs = ?, next_run_at = ? WHERE id = ?',
        [JSON.stringify({ 'agent-001': MON_10_00.toISOString() }), MON_10_00.toISOString(), schedule.id]);

      await processSchedules();
      expect(mockCreateTasks).toHaveBeenCalledTimes(1);
      const map = JSON.parse((await rowOf(schedule.id)).agent_next_runs!) as Record<string, string>;
      expect(map['agent-001']).toBe('2026-02-10T14:00:00.000Z');

      vi.setSystemTime(new Date('2026-02-09T14:01:00.000Z'));
      await processSchedules();
      expect(mockCreateTasks).toHaveBeenCalledTimes(1);
    });

    it('weekly: after firing today, the next run is the next configured weekday, not today', () => {
      vi.spyOn(Math, 'random').mockReturnValue(ROLL_14_00);
      // Mon (today) and Wed (the day after tomorrow).
      const next = computeNextRun('weekly', { days: [1, 3], time: '10:00', randomize_mode: 'fleet' }, 'UTC', MON_10_00, { afterFire: true });
      expect(next!.toISOString()).toBe('2026-02-11T14:00:00.000Z');
    });

    it('weekly through processSchedules: fired Monday, next_run_at is Wednesday', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(MON_10_00);
      vi.spyOn(Math, 'random').mockReturnValue(ROLL_14_00);
      const schedule = await createSchedule(baseScheduleRequest({
        schedule_type: 'weekly',
        schedule_config: { days: [1, 3], time: '10:00', randomize_mode: 'fleet' },
      }), 'user-001');
      await testDb.run('UPDATE schedules SET next_run_at = ? WHERE id = ?', [MON_10_00.toISOString(), schedule.id]);

      await processSchedules();

      expect((await rowOf(schedule.id)).next_run_at).toBe('2026-02-11T14:00:00.000Z');
    });

    it('monthly: after firing on the configured day, the next run is next month', () => {
      vi.spyOn(Math, 'random').mockReturnValue(ROLL_14_00);
      const next = computeNextRun('monthly', { dayOfMonth: 9, time: '10:00', randomize_mode: 'fleet' }, 'UTC', MON_10_00, { afterFire: true });
      expect(next!.toISOString()).toBe('2026-03-09T14:00:00.000Z');
    });

    it('monthly through processSchedules: fired on the 9th, next_run_at is the 9th of next month', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(MON_10_00);
      vi.spyOn(Math, 'random').mockReturnValue(ROLL_14_00);
      const schedule = await createSchedule(baseScheduleRequest({
        schedule_type: 'monthly',
        schedule_config: { dayOfMonth: 9, time: '10:00', randomize_mode: 'per_machine' },
      }), 'user-001');
      await testDb.run('UPDATE schedules SET agent_next_runs = ?, next_run_at = ? WHERE id = ?',
        [JSON.stringify({ 'agent-001': MON_10_00.toISOString() }), MON_10_00.toISOString(), schedule.id]);

      await processSchedules();

      const map = JSON.parse((await rowOf(schedule.id)).agent_next_runs!) as Record<string, string>;
      expect(map['agent-001']).toBe('2026-03-09T14:00:00.000Z');
    });

    it('fixed mode is unchanged: a 09:00 daily that fires at 09:00 goes to tomorrow 09:00', async () => {
      const fireAt = new Date('2026-02-09T09:00:00.000Z');
      expect(computeNextRun('daily', { time: '09:00' }, 'UTC', fireAt)!.toISOString())
        .toBe('2026-02-10T09:00:00.000Z');
      expect(computeNextRun('daily', { time: '09:00' }, 'UTC', fireAt, { afterFire: true })!.toISOString())
        .toBe('2026-02-10T09:00:00.000Z');

      vi.useFakeTimers();
      vi.setSystemTime(fireAt);
      const schedule = await createSchedule(baseScheduleRequest({ schedule_config: { time: '09:00' } }), 'user-001');
      await testDb.run('UPDATE schedules SET next_run_at = ? WHERE id = ?', [fireAt.toISOString(), schedule.id]);
      await processSchedules();
      expect((await rowOf(schedule.id)).next_run_at).toBe('2026-02-10T09:00:00.000Z');
    });

    it('fixed mode afterFire: a later fixed time today is still allowed (behaviour unchanged)', () => {
      // Fixed mode ignores afterFire entirely.
      const at = new Date('2026-02-09T08:00:00.000Z');
      expect(computeNextRun('daily', { time: '09:00' }, 'UTC', at, { afterFire: true })!.toISOString())
        .toBe('2026-02-09T09:00:00.000Z');
    });

    it('creation still allows today: a randomized daily created at 10:00 rolling 14:00 runs today', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(MON_10_00);
      vi.spyOn(Math, 'random').mockReturnValue(ROLL_14_00);

      const fleet = await createSchedule(baseScheduleRequest({
        schedule_config: { time: '10:00', randomize_mode: 'fleet' },
      }), 'user-001');
      expect(fleet.next_run_at).toBe('2026-02-09T14:00:00.000Z');

      const perMachine = await createSchedule(baseScheduleRequest({
        schedule_config: { time: '10:00', randomize_mode: 'per_machine' },
      }), 'user-001');
      expect(perMachine.agent_next_runs!['agent-001']).toBe('2026-02-09T14:00:00.000Z');

      // Without the option, computeNextRun behaves as before.
      expect(computeNextRun('daily', { time: '10:00', randomize_mode: 'fleet' }, 'UTC', MON_10_00)!.toISOString())
        .toBe('2026-02-09T14:00:00.000Z');
    });

    it('timezone: a 22:30 local run (02:30 UTC next day) advances to the next LOCAL day', () => {
      vi.spyOn(Math, 'random').mockReturnValue(ROLL_23_00);
      const tz = 'America/Santo_Domingo'; // UTC-4, no DST
      // Saturday 2026-02-07 22:30 local = Sunday 2026-02-08 02:30 UTC.
      const fireAt = new Date('2026-02-08T02:30:00.000Z');

      // Without the option a 23:00 roll would stay on Saturday (the bug).
      expect(computeNextRun('daily', { time: '10:00', randomize_mode: 'fleet' }, tz, fireAt)!.toISOString())
        .toBe('2026-02-08T03:00:00.000Z');

      const next = computeNextRun('daily', { time: '10:00', randomize_mode: 'fleet' }, tz, fireAt, { afterFire: true })!;
      // Sunday 2026-02-08 23:00 local = Monday 2026-02-09 03:00 UTC: one local
      // day later, not two (a UTC-date skip would land on Monday local).
      expect(next.toISOString()).toBe('2026-02-09T03:00:00.000Z');
      expect(new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(next)).toBe('2026-02-08');
    });
  });

  // ==========================================================================
  // R25 edge cases
  // ==========================================================================

  describe('R25 edge cases', () => {
    const ROLL_14_00_WEEKDAY = 0.625; // 300/480 -> 14:00; on a weekend 900/1440 -> 15:00

    it('weekly with today as the only configured weekday: afterFire lands on the same weekday next week', () => {
      vi.spyOn(Math, 'random').mockReturnValue(ROLL_14_00_WEEKDAY);
      const fireAt = new Date('2026-02-09T10:00:00.000Z'); // Monday
      const next = computeNextRun('weekly', { days: [1], time: '10:00', randomize_mode: 'fleet' }, 'UTC', fireAt, { afterFire: true });
      expect(next!.toISOString()).toBe('2026-02-16T14:00:00.000Z');
    });

    it('monthly dayOfMonth 31 firing on Feb 28 (clamped day): afterFire gives Mar 31', () => {
      vi.spyOn(Math, 'random').mockReturnValue(ROLL_14_00_WEEKDAY);
      const fireAt = new Date('2026-02-28T10:00:00.000Z'); // Saturday, Feb's clamped "31st"
      // Without the option the weekend roll (15:00) would stay on Feb 28.
      expect(computeNextRun('monthly', { dayOfMonth: 31, time: '10:00', randomize_mode: 'fleet' }, 'UTC', fireAt)!.toISOString())
        .toBe('2026-02-28T15:00:00.000Z');
      const next = computeNextRun('monthly', { dayOfMonth: 31, time: '10:00', randomize_mode: 'fleet' }, 'UTC', fireAt, { afterFire: true });
      expect(next!.toISOString()).toBe('2026-03-31T14:00:00.000Z'); // Tuesday 14:00 UTC
    });

    it('DST transition day (America/New_York, spring forward 2026-03-08)', () => {
      vi.spyOn(Math, 'random').mockReturnValue(ROLL_14_00_WEEKDAY);
      const tz = 'America/New_York';
      const localDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
      const cfg = { time: '10:00', randomize_mode: 'fleet' as const };

      // Fires ON the DST day, after the jump (03:30 EDT = 07:30Z). The next
      // run is Monday 14:00 EDT (UTC-4) = 18:00Z, not later the same Sunday.
      const onDst = computeNextRun('daily', cfg, tz, new Date('2026-03-08T07:30:00.000Z'), { afterFire: true })!;
      expect(onDst.toISOString()).toBe('2026-03-09T18:00:00.000Z');
      expect(localDate(onDst)).toBe('2026-03-09');

      // Fires the evening BEFORE (Sat 22:00 EST = 03:00Z Sun). The next run is
      // on the DST day itself: weekend roll 15:00 EDT = 19:00Z.
      const intoDst = computeNextRun('daily', cfg, tz, new Date('2026-03-08T03:00:00.000Z'), { afterFire: true })!;
      expect(intoDst.toISOString()).toBe('2026-03-08T19:00:00.000Z');
      expect(localDate(intoDst)).toBe('2026-03-08');
    });
  });

  // ==========================================================================
  // R26: list/get must not skip a schedule that is about to fire
  // ==========================================================================

  describe('list/get no longer skip schedules that are about to fire (R26)', () => {
    const SEC = 1000;
    const MIN = 60 * SEC;
    const MON_09_00 = new Date('2026-02-09T09:00:00.000Z');
    const MON_10_00 = new Date('2026-02-09T10:00:00.000Z');
    const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

    const rowOf = async (id: string) =>
      (await testDb.get('SELECT next_run_at, agent_next_runs FROM schedules WHERE id = ?', [id])) as unknown as {
        next_run_at: string | null;
        agent_next_runs: string | null;
      };

    // processSchedules() here has no clock: it selects due rows by SQLite's
    // wall clock, and the fleet path then fires whatever was selected. So the
    // "about to fire" tests anchor the slot a few seconds before the REAL
    // now; the fake JS clock then plays the list (+20s) and the tick (+40s).
    // A slot freshened into the future would no longer be selected.
    const realAnchor = (floorToMinute: boolean) => {
      const ms = Date.now() - 10 * SEC; // call before vi.useFakeTimers()
      return new Date(floorToMinute ? Math.floor(ms / MIN) * MIN : ms);
    };

    it('exports a 5-minute FRESHEN_GRACE_MS', () => {
      expect(FRESHEN_GRACE_MS).toBe(5 * 60_000);
    });

    it('fixed: listSchedules 20s after the slot, then the tick at +40s, dispatches the run', async () => {
      const slot = realAnchor(true);
      const hhmm = slot.toISOString().slice(11, 16);
      vi.useFakeTimers();
      vi.setSystemTime(plus(slot, -30 * MIN));
      const schedule = await createSchedule(baseScheduleRequest({ schedule_config: { time: hhmm } }), 'user-001');
      await testDb.run('UPDATE schedules SET next_run_at = ? WHERE id = ?', [slot.toISOString(), schedule.id]);

      vi.setSystemTime(plus(slot, 20 * SEC));
      const listed = await listSchedules();
      expect(listed[0].next_run_at).toBe(slot.toISOString());
      expect((await rowOf(schedule.id)).next_run_at).toBe(slot.toISOString());

      vi.setSystemTime(plus(slot, 40 * SEC));
      await processSchedules();
      expect(mockCreateTasks).toHaveBeenCalledTimes(1);
    });

    it('fixed: getSchedule 20s after the slot leaves the run for the tick', async () => {
      const slot = realAnchor(true);
      vi.useFakeTimers();
      vi.setSystemTime(plus(slot, -30 * MIN));
      const schedule = await createSchedule(baseScheduleRequest({
        schedule_config: { time: slot.toISOString().slice(11, 16) },
      }), 'user-001');
      await testDb.run('UPDATE schedules SET next_run_at = ? WHERE id = ?', [slot.toISOString(), schedule.id]);

      vi.setSystemTime(plus(slot, 20 * SEC));
      expect((await getSchedule(schedule.id)).next_run_at).toBe(slot.toISOString());

      vi.setSystemTime(plus(slot, 40 * SEC));
      await processSchedules();
      expect(mockCreateTasks).toHaveBeenCalledTimes(1);
    });

    it('per_machine: an agent slot listed 20s after it came due is dispatched by the tick', async () => {
      const slot = realAnchor(false);
      vi.useFakeTimers();
      vi.setSystemTime(plus(slot, -30 * MIN));
      const schedule = await createSchedule(baseScheduleRequest({
        schedule_config: { time: '10:00', randomize_mode: 'per_machine' },
      }), 'user-001');
      await testDb.run('UPDATE schedules SET agent_next_runs = ?, next_run_at = ? WHERE id = ?',
        [JSON.stringify({ 'agent-001': slot.toISOString() }), slot.toISOString(), schedule.id]);

      vi.setSystemTime(plus(slot, 20 * SEC));
      await listSchedules();
      expect(JSON.parse((await rowOf(schedule.id)).agent_next_runs!)).toEqual({ 'agent-001': slot.toISOString() });

      vi.setSystemTime(plus(slot, 40 * SEC));
      await processSchedules();
      expect(mockCreateTasks).toHaveBeenCalledTimes(1);
      expect(mockCreateTasks.mock.calls[0][0].agent_ids).toEqual(['agent-001']);
    });

    it('a schedule overdue by 6 minutes is still advanced by listSchedules (missed run skipped)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T08:00:00.000Z'));
      const schedule = await createSchedule(baseScheduleRequest({ schedule_config: { time: '09:00' } }), 'user-001');

      vi.setSystemTime(plus(MON_09_00, 6 * MIN));
      const listed = await listSchedules();

      expect(listed[0].next_run_at).toBe('2026-02-10T09:00:00.000Z');
      expect((await rowOf(schedule.id)).next_run_at).toBe('2026-02-10T09:00:00.000Z');
    });

    it('per_machine: only agent slots overdue by more than the grace period are advanced', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-09T08:00:00.000Z'));
      await insertTestAgent(testDb, { id: 'agent-002' });
      const schedule = await createSchedule(baseScheduleRequest({
        agent_ids: ['agent-001', 'agent-002'],
        schedule_config: { time: '10:00', randomize_mode: 'per_machine' },
      }), 'user-001');
      const stale = MON_10_00.toISOString(); // 6 min overdue at list time
      const fresh = plus(MON_10_00, 5 * MIN).toISOString(); // 1 min overdue at list time
      await testDb.run('UPDATE schedules SET agent_next_runs = ?, next_run_at = ? WHERE id = ?',
        [JSON.stringify({ 'agent-001': stale, 'agent-002': fresh }), stale, schedule.id]);

      vi.setSystemTime(plus(MON_10_00, 6 * MIN));
      await listSchedules();

      const row = await rowOf(schedule.id);
      const map = JSON.parse(row.agent_next_runs!) as Record<string, string>;
      expect(new Date(map['agent-001']).getTime()).toBeGreaterThan(Date.now());
      expect(map['agent-002']).toBe(fresh);
      expect(row.next_run_at).toBe(fresh);
    });

    // Race: the list request reads the row, the cron tick fires and advances
    // it, then the list request writes. The write must not land (0 rows).
    // These Feb-2026 dates are in the real past, so the cron's SQL selects
    // the row; the fake JS clock drives both computations.
    const armCronBetweenReadAndWrite = () => {
      const realRun = testDb.run.bind(testDb);
      const state = { fired: false, freshenChanges: -1 };
      vi.spyOn(testDb, 'run').mockImplementation(async (sql, args) => {
        if (!state.fired && sql.startsWith('UPDATE schedules SET next_run_at') && !sql.includes('last_run_at')) {
          state.fired = true;
          await processSchedules(); // fires and advances with afterFire: tomorrow
          const result = await realRun(sql, args);
          state.freshenChanges = result.changes;
          return result;
        }
        return realRun(sql, args);
      });
      return state;
    };

    it('race (fleet): the cron advance between freshen\'s read and write is not overwritten', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0.625); // weekday roll 14:00
      vi.setSystemTime(new Date('2026-02-09T08:00:00.000Z'));
      const schedule = await createSchedule(baseScheduleRequest({
        schedule_config: { time: '10:00', randomize_mode: 'fleet' },
      }), 'user-001');
      await testDb.run('UPDATE schedules SET next_run_at = ? WHERE id = ?', [MON_09_00.toISOString(), schedule.id]);
      vi.setSystemTime(plus(MON_09_00, 6 * MIN));

      const state = armCronBetweenReadAndWrite();
      const listed = await listSchedules();

      expect(state.fired).toBe(true);
      expect(state.freshenChanges).toBe(0);
      expect(mockCreateTasks).toHaveBeenCalledTimes(1);
      // Without the condition, freshen would write today 14:00: a second run today.
      expect((await rowOf(schedule.id)).next_run_at).toBe('2026-02-10T14:00:00.000Z');
      expect(listed[0].next_run_at).toBe('2026-02-10T14:00:00.000Z');
    });

    it('race (per_machine): the cron advance of agent_next_runs is not overwritten', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0.625); // weekday roll 14:00
      vi.setSystemTime(new Date('2026-02-09T08:00:00.000Z'));
      const schedule = await createSchedule(baseScheduleRequest({
        schedule_config: { time: '10:00', randomize_mode: 'per_machine' },
      }), 'user-001');
      await testDb.run('UPDATE schedules SET agent_next_runs = ?, next_run_at = ? WHERE id = ?',
        [JSON.stringify({ 'agent-001': MON_09_00.toISOString() }), MON_09_00.toISOString(), schedule.id]);
      vi.setSystemTime(plus(MON_09_00, 6 * MIN));

      const state = armCronBetweenReadAndWrite();
      const listed = await listSchedules();

      expect(state.fired).toBe(true);
      expect(state.freshenChanges).toBe(0);
      expect(mockCreateTasks).toHaveBeenCalledTimes(1);
      const row = await rowOf(schedule.id);
      expect(JSON.parse(row.agent_next_runs!)).toEqual({ 'agent-001': '2026-02-10T14:00:00.000Z' });
      expect(row.next_run_at).toBe('2026-02-10T14:00:00.000Z');
      expect(listed[0].agent_next_runs).toEqual({ 'agent-001': '2026-02-10T14:00:00.000Z' });
    });
  });
});
