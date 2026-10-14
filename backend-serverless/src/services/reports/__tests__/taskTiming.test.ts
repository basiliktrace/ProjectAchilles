import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DbHelper } from '../../agent/database.js';

let testDb: DbHelper;
vi.mock('../../agent/database.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent/database.js')>()),
  getDb: async () => testDb,
}));

const { createTestDatabase, insertTestAgent, insertTestTask } = await import('../../../__tests__/helpers/db.js');
const { getRunStartTimes, parseStartedAt } = await import('../taskTiming.js');

describe('parseStartedAt', () => {
  it('returns the agent started_at as ISO, null otherwise', () => {
    expect(parseStartedAt(JSON.stringify({ started_at: '2026-10-12T12:41:06Z' }))).toBe('2026-10-12T12:41:06.000Z');
    expect(parseStartedAt('{not json')).toBeNull();
    expect(parseStartedAt(null)).toBeNull();
  });
});

describe('getRunStartTimes', () => {
  beforeEach(async () => {
    testDb = await createTestDatabase();
    await insertTestAgent(testDb);
  });

  it('maps task ids to started_at and skips tasks without one', async () => {
    await insertTestTask(testDb, { id: 'task-a' });
    await insertTestTask(testDb, { id: 'task-b' });
    await testDb.run('UPDATE tasks SET result = ? WHERE id = ?', [JSON.stringify({ started_at: '2026-10-12T12:41:06Z' }), 'task-a']);
    const map = await getRunStartTimes(['task-a', 'task-b', 'task-missing']);
    expect([...map.entries()]).toEqual([['task-a', '2026-10-12T12:41:06.000Z']]);
  });

  it('returns an empty map for no ids', async () => {
    expect((await getRunStartTimes([])).size).toBe(0);
  });
});
