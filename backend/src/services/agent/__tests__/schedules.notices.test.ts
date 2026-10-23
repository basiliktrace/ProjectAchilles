import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { createTestDatabase, insertTestAgent } from '../../../__tests__/helpers/db.js';

let testDb: Database.Database;

vi.mock('../database.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../database.js')>();
  return { ...actual, getDatabase: () => testDb };
});

vi.mock('../test-catalog.service.js', () => ({ getTestMetadata: () => null }));

// Settings and builds live under a temp HOME. createTasks is real here.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const home = `${actual.tmpdir()}/pa-schedules-notices-${process.pid}`;
  const overrides = { homedir: () => home };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

const { processSchedules } = await import('../schedules.service.js');

const HOME = os.homedir();
const SETTINGS_DIR = path.join(HOME, '.projectachilles');
const NOW = new Date('2026-10-23T12:00:00.000Z'); // Friday
const MIN = 60_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

function writeSettings(enabled: boolean) {
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(SETTINGS_DIR, 'integrations.json'),
    JSON.stringify({
      alerts: {
        thresholds: { enabled: false },
        cooldown_minutes: 15,
        email: {
          smtp_host: 'smtp.example.test',
          smtp_port: 587,
          smtp_secure: false,
          smtp_user: 'u',
          smtp_pass: 'p',
          from_address: 'pa@example.test',
          recipients: [],
          configured: true,
          enabled: true,
        },
      },
      pre_execution_notices: { enabled, recipients: ['a@x.com'] },
    }),
  );
}

function writeBuild(testUuid: string) {
  const dir = path.join(SETTINGS_DIR, 'builds', testUuid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'test.exe'), 'binary');
  fs.writeFileSync(path.join(dir, 'build-meta.json'), JSON.stringify({ binary_name: 'test.exe' }));
}

const METADATA = {
  category: 'test', subcategory: '', severity: 'medium', techniques: [], tactics: [],
  threat_actor: '', target: [], complexity: '', tags: [], score: null, integrations: [],
};

function insertSchedule(
  id: string,
  agentIds: string[],
  opts: { nextRunAt: Date; config?: Record<string, unknown>; agentNextRuns?: Record<string, string> },
) {
  testDb
    .prepare(`
      INSERT INTO schedules (id, name, agent_ids, org_id, test_uuid, test_name, binary_name, metadata, schedule_type,
        schedule_config, timezone, next_run_at, status, created_by, agent_next_runs)
      VALUES (?, ?, ?, 'org-001', ?, 'T', 'test.exe', ?, 'daily', ?, 'UTC', ?, 'active', 'creator', ?)
    `)
    .run(
      id,
      `Sched ${id}`,
      JSON.stringify(agentIds),
      `uuid-${id}`,
      JSON.stringify(METADATA),
      JSON.stringify(opts.config ?? { time: '12:00' }),
      opts.nextRunAt.toISOString(),
      opts.agentNextRuns ? JSON.stringify(opts.agentNextRuns) : null,
    );
  writeBuild(`uuid-${id}`);
}

const tasksOf = () =>
  testDb.prepare('SELECT id, batch_id, notice_id, agent_id FROM tasks ORDER BY agent_id').all() as Array<{
    id: string;
    batch_id: string;
    notice_id: string | null;
    agent_id: string;
  }>;
const notices = () => testDb.prepare('SELECT * FROM run_notices ORDER BY created_at').all() as Array<Record<string, any>>;

beforeEach(() => {
  testDb = createTestDatabase();
  fs.rmSync(SETTINGS_DIR, { recursive: true, force: true });
  writeSettings(true);
  for (const a of ['agent-1', 'agent-2', 'agent-3']) insertTestAgent(testDb, { id: a, hostname: `host-${a}` });
});

afterAll(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe('processSchedules with pre-execution notices', () => {
  it('links two fleet schedules due in one tick to one run notice', () => {
    insertSchedule('s1', ['agent-1'], { nextRunAt: at(-MIN) });
    insertSchedule('s2', ['agent-2'], { nextRunAt: at(-MIN) });

    const result = processSchedules(NOW);

    expect(result.errors).toEqual([]);
    const ns = notices();
    expect(ns).toHaveLength(1);
    expect(ns[0].kind).toBe('run');
    expect(ns[0].state).toBe('pending');
    expect(ns[0].source_type).toBe('schedule');
    expect(JSON.parse(ns[0].schedule_ids).sort()).toEqual(['s1', 's2']);
    const ts = tasksOf();
    expect(ts).toHaveLength(2);
    expect(new Set(ts.map((t) => t.batch_id)).size).toBe(2);
    expect(ts.every((t) => t.notice_id === ns[0].id)).toBe(true);
  });

  it('skips a fleet schedule whose previous run notice is still pending, and advances next_run_at', () => {
    insertSchedule('s1', ['agent-1'], { nextRunAt: at(-MIN) });
    processSchedules(NOW);
    expect(tasksOf()).toHaveLength(1);

    // Next occurrence comes due while the notice is still undelivered.
    testDb.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(at(24 * 60 * MIN - MIN).toISOString(), 's1');
    const later = at(24 * 60 * MIN);
    const result = processSchedules(later);

    expect(result.errors).toEqual([]);
    expect(tasksOf()).toHaveLength(1);
    const ns = notices();
    expect(ns).toHaveLength(2);
    expect(ns[1].state).toBe('skipped');
    expect(ns[1].skip_reason).toBe('previous run still waiting for notice delivery');
    expect(JSON.parse(ns[1].schedule_ids)).toEqual(['s1']);
    const row = testDb.prepare('SELECT next_run_at, last_run_at FROM schedules WHERE id = ?').get('s1') as any;
    expect(row.next_run_at > later.toISOString()).toBe(true);
    expect(row.last_run_at).toBe(later.toISOString());
  });

  it('shares one day notice across a per_machine schedule\'s agents due at different minutes', () => {
    insertSchedule('pm', ['agent-1', 'agent-2', 'agent-3'], {
      nextRunAt: at(1 * MIN),
      config: { time: '12:00', randomize_mode: 'per_machine' },
      agentNextRuns: {
        'agent-1': at(1 * MIN).toISOString(),
        'agent-2': at(8 * MIN).toISOString(),
        'agent-3': at(15 * MIN).toISOString(),
      },
    });

    processSchedules(at(2 * MIN));
    processSchedules(at(9 * MIN));
    processSchedules(at(16 * MIN));

    const ts = tasksOf();
    expect(ts.map((t) => t.agent_id)).toEqual(['agent-1', 'agent-2', 'agent-3']);
    const ns = notices();
    expect(ns).toHaveLength(1);
    expect(ns[0].kind).toBe('day');
    expect(ns[0].schedule_id).toBe('pm');
    expect(ts.every((t) => t.notice_id === ns[0].id)).toBe(true);
  });

  it('leaves notice_id NULL and creates no notices when the gate is disabled', () => {
    writeSettings(false);
    insertSchedule('s1', ['agent-1'], { nextRunAt: at(-MIN) });
    insertSchedule('pm', ['agent-2', 'agent-3'], {
      nextRunAt: at(-MIN),
      config: { time: '12:00', randomize_mode: 'per_machine' },
      agentNextRuns: { 'agent-2': at(-MIN).toISOString(), 'agent-3': at(-MIN).toISOString() },
    });

    processSchedules(NOW);

    const ts = tasksOf();
    expect(ts).toHaveLength(3);
    expect(ts.every((t) => t.notice_id === null)).toBe(true);
    expect(notices()).toHaveLength(0);
  });

  it('does not skip a schedule on a leftover pending notice when the gate is disabled', () => {
    insertSchedule('s1', ['agent-1'], { nextRunAt: at(-MIN) });
    processSchedules(NOW); // creates a pending notice
    writeSettings(false);
    testDb.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(at(60 * MIN).toISOString(), 's1');

    processSchedules(at(61 * MIN));

    expect(tasksOf()).toHaveLength(2);
    expect(notices()).toHaveLength(1);
  });
});
