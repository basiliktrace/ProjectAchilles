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

const { createTasks, createTasksBatch, retryTask, expireStaleTasks, expireOverdueTasks } =
  await import('../tasks.service.js');

function insertRunTask(id: string, extra: Record<string, unknown> = {}) {
  insertTestTask(testDb, { id, agent_id: 'agent-001', ...extra });
  testDb.prepare('UPDATE tasks SET campaign_run_id = ? WHERE id = ?').run('r1', id);
}

const runOf = (where: string) =>
  (testDb.prepare(`SELECT campaign_run_id FROM tasks WHERE ${where}`).get() as any);

describe('tasks.campaign_run_id', () => {
  beforeEach(() => {
    testDb = createTestDatabase();
    insertTestAgent(testDb, { id: 'agent-001' });
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

  it('createTasks writes campaignRunId', () => {
    const ids = createTasks(req, 'org', 'user', { campaignRunId: 'r1' });
    expect(runOf(`id = '${ids[0]}'`).campaign_run_id).toBe('r1');
  });

  it('createTasksBatch passes campaignRunId through', () => {
    const ids = createTasksBatch([req, { ...req, test_uuid: 'u2' }], 'org', 'user', { campaignRunId: 'r1' });
    expect(ids.flat()).toHaveLength(2);
    const rows = testDb.prepare('SELECT campaign_run_id FROM tasks').all() as any[];
    expect(rows.map((r) => r.campaign_run_id)).toEqual(['r1', 'r1']);
  });

  it('leaves campaign_run_id NULL without the option', () => {
    const ids = createTasks(req, 'org', 'user');
    expect(runOf(`id = '${ids[0]}'`).campaign_run_id).toBeNull();
  });

  it('expireStaleTasks retry inherits campaign_run_id', () => {
    insertRunTask('p', { status: 'executing' });
    testDb.prepare("UPDATE agents SET last_heartbeat = datetime('now', '-1 hour') WHERE id = 'agent-001'").run();
    const origPrepare = testDb.prepare.bind(testDb);
    vi.spyOn(testDb, 'prepare').mockImplementation(((sql: string) => {
      if (sql.includes('is_back_online')) {
        return { get: () => ({ last_heartbeat: 'x', is_back_online: 1 }) } as any;
      }
      return origPrepare(sql);
    }) as any);
    expireStaleTasks();
    vi.restoreAllMocks();
    expect(runOf("original_task_id = 'p'")?.campaign_run_id).toBe('r1');
  });

  it('expireOverdueTasks retry inherits campaign_run_id', () => {
    insertRunTask('p', { status: 'executing', assigned_at: '2000-01-01 00:00:00' });
    expireOverdueTasks();
    expect(runOf("original_task_id = 'p'")?.campaign_run_id).toBe('r1');
  });

  it('retryTask clone inherits campaign_run_id', () => {
    insertRunTask('orig', { status: 'failed' });
    retryTask('orig', 'u');
    expect(runOf("original_task_id = 'orig'")?.campaign_run_id).toBe('r1');
  });
});
