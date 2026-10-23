import { describe, it, expect } from 'vitest';
import { createTestDatabase } from '../../../__tests__/helpers/db.js';
import { initializeTables } from '../../agent/database.js';

function insertNotice(db: ReturnType<typeof createTestDatabase>, id: string, kind: string, scheduleId: string | null, windowDate: string | null) {
  db.prepare(
    `INSERT INTO run_notices (id, kind, state, source_type, timezone, created_by, created_at, schedule_id, window_date)
     VALUES (?, ?, 'pending', 'schedule', 'UTC', 'u', ?, ?, ?)`
  ).run(id, kind, new Date().toISOString(), scheduleId, windowDate);
}

describe('run_notices schema', () => {
  it('creates run_notices and tasks.notice_id', () => {
    const db = createTestDatabase();
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('run_notices');
    const cols = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('notice_id');
  });

  it('applies column defaults', () => {
    const db = createTestDatabase();
    insertNotice(db, 'n1', 'run', null, null);
    const row = db.prepare('SELECT * FROM run_notices WHERE id = ?').get('n1') as Record<string, unknown>;
    expect(row.schedule_ids).toBe('[]');
    expect(row.recipients).toBe('[]');
    expect(row.attempts).toBe(0);
    expect(row.finished_attempts).toBe(0);
    expect(row.slack_failure_alerted).toBe(0);
    expect(row.slack_not_delivered_alerted).toBe(0);
  });

  it('rejects invalid kind and state', () => {
    const db = createTestDatabase();
    expect(() => insertNotice(db, 'n1', 'bogus', null, null)).toThrow(/CHECK/);
    expect(() =>
      db.prepare(
        `INSERT INTO run_notices (id, kind, state, source_type, timezone, created_by, created_at)
         VALUES ('n2','run','weird','run_now','UTC','u','x')`
      ).run()
    ).toThrow(/CHECK/);
  });

  it('enforces uniqueness of (schedule_id, window_date) for day notices only', () => {
    const db = createTestDatabase();
    insertNotice(db, 'd1', 'day', 's1', '2026-10-23');
    expect(() => insertNotice(db, 'd2', 'day', 's1', '2026-10-23')).toThrowError(
      expect.objectContaining({ code: 'SQLITE_CONSTRAINT_UNIQUE' })
    );
    insertNotice(db, 'd3', 'day', 's1', '2026-10-24');
    insertNotice(db, 'r1', 'run', null, null);
    insertNotice(db, 'r2', 'run', null, null);
    insertNotice(db, 'r3', 'run', 's1', '2026-10-23');
  });

  it('creates the expected indexes', () => {
    const db = createTestDatabase();
    const idx = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as { name: string }[]).map((i) => i.name);
    expect(idx).toEqual(expect.arrayContaining(['idx_run_notices_state', 'idx_run_notices_day', 'idx_tasks_notice']));
  });

  it('is idempotent', () => {
    const db = createTestDatabase();
    expect(() => initializeTables(db)).not.toThrow();
    expect(() => initializeTables(db)).not.toThrow();
  });
});
