import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDatabase, insertTestAgent, insertTestTask } from '../../../__tests__/helpers/db.js';

let testDb: Database.Database;

vi.mock('../database.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../database.js')>();
  return { ...actual, getDatabase: () => testDb };
});

vi.mock('../test-catalog.service.js', () => ({
  getTestMetadata: () => null,
}));

const { mockExistsSync, mockReadFileSync, mockStatSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn().mockReturnValue(true),
  mockReadFileSync: vi.fn(),
  mockStatSync: vi.fn().mockReturnValue({ size: 1024 }),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const overrides = { existsSync: mockExistsSync, readFileSync: mockReadFileSync, statSync: mockStatSync };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const overrides = { homedir: () => '/mock-home' };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

vi.mock('../../integrations/settings.js', () => ({
  IntegrationsSettingsService: class {
    getAzureCredentials() { return null; }
  },
}));

const { createTasks, getNextTask, retryTask, expireStaleTasks, expireOverdueTasks } =
  await import('../tasks.service.js');

const NOW = new Date('2026-10-23T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

function insertNotice(id: string, state: string, releaseAt: string | null, deadline: string | null) {
  testDb.prepare(`
    INSERT INTO run_notices (id, kind, state, source_type, timezone, created_by, created_at, release_at, pickup_deadline)
    VALUES (?, 'run', ?, 'run_now', 'UTC', 'u', ?, ?, ?)
  `).run(id, state, iso(-3600_000), releaseAt, deadline);
}

function insertGated(id: string, noticeId: string | null, extra: Record<string, unknown> = {}) {
  insertTestTask(testDb, { id, agent_id: 'agent-001', ...extra });
  testDb.prepare('UPDATE tasks SET notice_id = ? WHERE id = ?').run(noticeId, id);
}

describe('notice hold', () => {
  beforeEach(() => {
    testDb = createTestDatabase();
    insertTestAgent(testDb, { id: 'agent-001' });
  });

  describe('getNextTask', () => {
    it('returns a task with NULL notice_id (legacy)', () => {
      insertGated('t1', null);
      expect(getNextTask('agent-001', NOW)?.id).toBe('t1');
    });

    it('holds a task whose notice is pending', () => {
      insertNotice('n1', 'pending', null, null);
      insertGated('t1', 'n1');
      expect(getNextTask('agent-001', NOW)).toBeNull();
    });

    it('holds until release_at, releases exactly at release_at', () => {
      insertNotice('n1', 'sent', iso(1000), iso(3600_000));
      insertGated('t1', 'n1');
      expect(getNextTask('agent-001', NOW)).toBeNull();

      testDb.prepare("UPDATE run_notices SET release_at = ? WHERE id = 'n1'").run(NOW.toISOString());
      expect(getNextTask('agent-001', NOW)?.id).toBe('t1');
    });

    it('does not return a task once pickup_deadline has passed (<= now)', () => {
      insertNotice('n1', 'sent', iso(-60_000), NOW.toISOString());
      insertGated('t1', 'n1');
      expect(getNextTask('agent-001', NOW)).toBeNull();
    });

    it('holds a not_delivered notice', () => {
      insertNotice('n1', 'not_delivered', iso(-60_000), iso(3600_000));
      insertGated('t1', 'n1');
      expect(getNextTask('agent-001', NOW)).toBeNull();
    });

    it('returns a released overridden task', () => {
      insertNotice('n1', 'overridden', iso(-1000), iso(3600_000));
      insertGated('t1', 'n1');
      expect(getNextTask('agent-001', NOW)?.id).toBe('t1');
    });

    it('skips a held task but serves a later legacy one', () => {
      insertNotice('n1', 'pending', null, null);
      insertGated('held', 'n1', { priority: 10 });
      insertGated('free', null, { priority: 1 });
      expect(getNextTask('agent-001', NOW)?.id).toBe('free');
    });
  });

  describe('createTasks', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.endsWith('build-meta.json')) {
          return JSON.stringify({ binary_name: 'test-binary.exe', filename: 'test-binary.exe' });
        }
        return Buffer.from('fake-binary-content');
      });
      mockStatSync.mockReturnValue({ size: 2048 });
    });
    const req = {
      agent_ids: ['agent-001'],
      test_uuid: 'u1',
      test_name: 'T',
      binary_name: 'test-binary.exe',
    };

    it('writes notice_id when provided', () => {
      const ids = createTasks(req, 'org', 'user', { noticeId: 'n1' });
      const row = testDb.prepare('SELECT notice_id FROM tasks WHERE id = ?').get(ids[0]) as any;
      expect(row.notice_id).toBe('n1');
    });

    it('leaves notice_id NULL without options', () => {
      const ids = createTasks(req, 'org', 'user');
      const row = testDb.prepare('SELECT notice_id FROM tasks WHERE id = ?').get(ids[0]) as any;
      expect(row.notice_id).toBeNull();
    });
  });

  describe('retries', () => {
    it('expireStaleTasks retry copies parent notice_id', () => {
      testDb.prepare("UPDATE agents SET last_heartbeat = datetime('now') WHERE id = 'agent-001'").run();
      insertGated('p', 'n1', { status: 'executing' });
      // Make agent look offline at SELECT time but back online at re-check is not
      // possible in one call; instead use a null heartbeat agent then restore.
      testDb.prepare("UPDATE agents SET last_heartbeat = datetime('now', '-1 hour') WHERE id = 'agent-001'").run();
      const origPrepare = testDb.prepare.bind(testDb);
      // Force the "is back online" re-check to report online.
      vi.spyOn(testDb, 'prepare').mockImplementation(((sql: string) => {
        if (sql.includes('is_back_online')) {
          return { get: () => ({ last_heartbeat: 'x', is_back_online: 1 }) } as any;
        }
        return origPrepare(sql);
      }) as any);
      expireStaleTasks();
      vi.restoreAllMocks();
      const retry = testDb.prepare("SELECT notice_id FROM tasks WHERE original_task_id = 'p'").get() as any;
      expect(retry).toBeDefined();
      expect(retry.notice_id).toBe('n1');
    });

    it('expireOverdueTasks retry copies parent notice_id', () => {
      insertGated('p', 'n1', { status: 'executing', assigned_at: '2000-01-01 00:00:00' });
      expireOverdueTasks();
      const retry = testDb.prepare("SELECT notice_id FROM tasks WHERE original_task_id = 'p'").get() as any;
      expect(retry).toBeDefined();
      expect(retry.notice_id).toBe('n1');
    });

    it('does not touch a held pending task', () => {
      insertNotice('n1', 'pending', null, null);
      insertGated('held', 'n1', { status: 'pending' });
      expireStaleTasks();
      expireOverdueTasks();
      const row = testDb.prepare("SELECT status FROM tasks WHERE id = 'held'").get() as any;
      expect(row.status).toBe('pending');
    });

    it('retryTask uses the passed notice id, NULL when omitted', () => {
      insertGated('orig', 'old', { status: 'failed' });
      expect(retryTask('orig', 'u', 'n2')).toBeTruthy();
      const a = testDb.prepare("SELECT notice_id FROM tasks WHERE original_task_id = 'orig'").all() as any[];
      expect(a.map((r) => r.notice_id)).toEqual(['n2']);

      retryTask('orig', 'u');
      const b = testDb.prepare("SELECT notice_id FROM tasks WHERE original_task_id = 'orig' ORDER BY rowid").all() as any[];
      expect(b.map((r) => r.notice_id)).toEqual(['n2', null]);
    });
  });
});
