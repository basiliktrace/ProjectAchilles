import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

let testDb: Database.Database;
vi.mock('../../agent/database.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent/database.js')>()),
  getDatabase: () => testDb,
}));

const { createTestDatabase, insertTestAgent, insertTestTask } = await import('../../../__tests__/helpers/db.js');
const { getRunStartTimes, parseStartedAt } = await import('../taskTiming.js');

function setResult(id: string, result: string | null) {
  testDb.prepare('UPDATE tasks SET result = ? WHERE id = ?').run(result, id);
}

describe('parseStartedAt', () => {
  it('returns the agent started_at as ISO', () => {
    expect(parseStartedAt(JSON.stringify({ started_at: '2026-10-12T12:41:06Z' }))).toBe('2026-10-12T12:41:06.000Z');
  });

  it('returns null for missing, malformed or non-string input', () => {
    expect(parseStartedAt(JSON.stringify({ completed_at: '2026-10-12T12:47:49Z' }))).toBeNull();
    expect(parseStartedAt('{not json')).toBeNull();
    expect(parseStartedAt(null)).toBeNull();
    expect(parseStartedAt(JSON.stringify({ started_at: 'garbage' }))).toBeNull();
  });
});

describe('getRunStartTimes', () => {
  beforeEach(() => {
    testDb = createTestDatabase();
    insertTestAgent(testDb);
  });

  it('maps task ids to started_at and skips tasks without one', async () => {
    insertTestTask(testDb, { id: 'task-a' });
    insertTestTask(testDb, { id: 'task-b' });
    insertTestTask(testDb, { id: 'task-c' });
    setResult('task-a', JSON.stringify({ started_at: '2026-10-12T12:41:06Z' }));
    setResult('task-b', '{broken');

    const map = await getRunStartTimes(['task-a', 'task-b', 'task-c', 'task-missing']);
    expect([...map.entries()]).toEqual([['task-a', '2026-10-12T12:41:06.000Z']]);
  });

  it('returns an empty map for no ids', async () => {
    expect((await getRunStartTimes([])).size).toBe(0);
  });
});
