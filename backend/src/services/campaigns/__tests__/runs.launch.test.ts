import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { createTestDatabase, insertTestAgent } from '../../../__tests__/helpers/db.js';

let testDb: Database.Database;
const state = vi.hoisted(() => ({ home: `${process.env.TMPDIR ?? '/tmp'}/pa-launch-${process.pid}`, afterPreflight: null as null | (() => void) }));

vi.mock('../../agent/database.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent/database.js')>()),
  getDatabase: () => testDb,
}));
vi.mock('../../agent/test-catalog.service.js', () => ({
  getTestMetadata: (uuid: string) => ({ uuid, name: `Test ${uuid}`, techniques: [] }),
}));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const overrides = { homedir: () => state.home };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});
vi.mock('../../alerts/email.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../alerts/email.service.js')>()),
  sendMail: vi.fn().mockResolvedValue(undefined),
}));
// Lets a test mutate the world between preflight and task creation.
vi.mock('../preflight.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../preflight.js')>();
  return {
    ...actual,
    preflightCampaign: (c: Parameters<typeof actual.preflightCampaign>[0]) => {
      const r = actual.preflightCampaign(c);
      state.afterPreflight?.();
      return r;
    },
  };
});

const { createCampaign } = await import('../campaigns.service.js');
const { launchRun, PartialRunError } = await import('../runs.service.js');

const ORG = 'org-1';
const OPTS = { callerOrg: ORG, orgId: ORG, userId: 'u1', confirmPartial: false };

function buildDir(uuid: string) {
  return path.join(state.home, '.projectachilles', 'builds', uuid);
}
function writeBuild(uuid: string) {
  fs.mkdirSync(buildDir(uuid), { recursive: true });
  fs.writeFileSync(path.join(buildDir(uuid), 'build-meta.json'), JSON.stringify({ filename: `${uuid}.exe` }));
  fs.writeFileSync(path.join(buildDir(uuid), `${uuid}.exe`), 'x');
}
function enableNotices() {
  const dir = path.join(state.home, '.projectachilles');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'integrations.json'),
    JSON.stringify({
      alerts: {
        thresholds: { enabled: false },
        cooldown_minutes: 15,
        email: {
          smtp_host: 'smtp.example.test', smtp_port: 587, smtp_secure: false, smtp_user: 'u',
          smtp_pass: 'p', from_address: 'pa@example.test', recipients: [], configured: true, enabled: true,
        },
      },
      pre_execution_notices: {
        enabled: true, recipients: ['a@x.com'], lead_minutes: 5, max_wait_minutes: 60,
        pickup_window_minutes: 120, send_finished: true,
      },
    }),
  );
}
const count = (table: string) => (testDb.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
const run = (id: string) =>
  testDb.prepare('SELECT * FROM campaign_runs WHERE id = ?').get(id) as {
    notice_id: string | null; snapshot: string; task_count: number; org_id: string;
  };

describe('launchRun', () => {
  beforeEach(() => {
    fs.rmSync(state.home, { recursive: true, force: true });
    fs.mkdirSync(state.home, { recursive: true });
    state.afterPreflight = null;
    testDb = createTestDatabase();
    insertTestAgent(testDb, { id: 'a1', org_id: ORG, hostname: 'h1', os: 'windows' });
    insertTestAgent(testDb, { id: 'a2', org_id: ORG, hostname: 'h2', os: 'windows' });
    writeBuild('t1');
    writeBuild('t2');
  });
  afterEach(() => fs.rmSync(state.home, { recursive: true, force: true }));

  const mk = (tests: string[], agents: string[]) =>
    createCampaign({ name: 'C', framework_label: 'Q4', test_uuids: tests, agent_ids: agents }, ORG, 'u1');

  it('happy path: 2 tests x 2 agents creates 4 tasks carrying campaign_run_id; snapshot stored', () => {
    const c = mk(['t1', 't2'], ['a1', 'a2']);
    const r = launchRun(c.id, OPTS);
    expect(r).toMatchObject({ task_count: 4, skipped: 0 });
    const tasks = testDb.prepare('SELECT campaign_run_id FROM tasks').all() as { campaign_run_id: string }[];
    expect(tasks).toHaveLength(4);
    expect(tasks.every((t) => t.campaign_run_id === r.run_id)).toBe(true);
    const row = run(r.run_id);
    expect(row.task_count).toBe(4);
    expect(row.org_id).toBe(ORG);
    expect(JSON.parse(row.snapshot)).toEqual({
      campaign_name: 'C',
      framework_label: 'Q4',
      tests: [{ uuid: 't1', name: 'Test t1' }, { uuid: 't2', name: 'Test t2' }],
      agents: [{ id: 'a1', hostname: 'h1', os: 'windows' }, { id: 'a2', hostname: 'h2', os: 'windows' }],
      skipped: [],
    });
  });

  it('partial without confirm: PartialRunError 409 with skipped list; nothing written', () => {
    const c = mk(['t1', 't9'], ['a1']);
    let err: unknown;
    try { launchRun(c.id, OPTS); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(PartialRunError);
    expect((err as InstanceType<typeof PartialRunError>).statusCode).toBe(409);
    expect((err as InstanceType<typeof PartialRunError>).skipped).toEqual([
      { test_uuid: 't9', agent_id: 'a1', reason: 'not built' },
    ]);
    expect(count('campaign_runs')).toBe(0);
    expect(count('tasks')).toBe(0);
  });

  it('partial with confirm: dispatches only the dispatchable pairs', () => {
    const c = mk(['t1', 't9'], ['a1']);
    const r = launchRun(c.id, { ...OPTS, confirmPartial: true });
    expect(r).toMatchObject({ task_count: 1, skipped: 1 });
    expect(count('tasks')).toBe(1);
    expect(JSON.parse(run(r.run_id).snapshot).skipped).toHaveLength(1);
  });

  it('nothing dispatchable: 400', () => {
    const c = mk(['t9'], ['a1']);
    expect(() => launchRun(c.id, { ...OPTS, confirmPartial: true })).toThrow(
      expect.objectContaining({ statusCode: 400, message: 'Nothing to run: every test/host pair was skipped' }),
    );
  });

  it('agent moved to another org after save: 400, nothing written', () => {
    const c = mk(['t1'], ['a1', 'a2']);
    testDb.prepare("UPDATE agents SET org_id = 'org-2' WHERE id = 'a2'").run();
    expect(() => launchRun(c.id, OPTS)).toThrow(
      expect.objectContaining({ statusCode: 400, message: 'Agent a2 does not belong to your organization' }),
    );
    expect(count('campaign_runs')).toBe(0);
    expect(count('tasks')).toBe(0);
  });

  it('cross-org campaign: 404', () => {
    const c = mk(['t1'], ['a1']);
    expect(() => launchRun(c.id, { ...OPTS, callerOrg: 'org-2' })).toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
  });

  it('5001 pairs: 400 with exact message, nothing written', () => {
    const ins = testDb.prepare(
      `INSERT INTO agents (id, org_id, hostname, os, arch, agent_version, api_key_hash, status, last_heartbeat, enrolled_at, enrolled_by, tags)
       VALUES (?, ?, ?, 'windows', 'amd64', '1', 'h', 'active', ?, ?, 'u', '[]')`,
    );
    const now = new Date().toISOString();
    const ids: string[] = [];
    testDb.transaction(() => {
      for (let i = 0; i < 5001; i++) {
        ids.push(`bulk-${i}`);
        ins.run(`bulk-${i}`, ORG, `bh${i}`, now, now);
      }
    })();
    const c = mk(['t1'], ids);
    expect(() => launchRun(c.id, OPTS)).toThrow(
      expect.objectContaining({ statusCode: 400, message: 'Run would create 5001 tasks (max 5000)' }),
    );
    expect(count('campaign_runs')).toBe(0);
    expect(count('tasks')).toBe(0);
  });

  it('notices enabled: exactly one notice; every task notice_id equals the run notice_id', () => {
    enableNotices();
    const c = mk(['t1', 't2'], ['a1', 'a2']);
    const r = launchRun(c.id, OPTS);
    expect(count('run_notices')).toBe(1);
    const nid = run(r.run_id).notice_id;
    expect(nid).toEqual(expect.any(String));
    const tasks = testDb.prepare('SELECT notice_id FROM tasks').all() as { notice_id: string }[];
    expect(tasks).toHaveLength(4);
    expect(tasks.every((t) => t.notice_id === nid)).toBe(true);
  });

  it('notices disabled: notice_id is NULL', () => {
    const c = mk(['t1'], ['a1']);
    const r = launchRun(c.id, OPTS);
    expect(run(r.run_id).notice_id).toBeNull();
    expect(count('run_notices')).toBe(0);
  });

  it('atomic: createTasksBatch failing leaves no run, tasks or notice', () => {
    enableNotices();
    const c = mk(['t1', 't2'], ['a1', 'a2']);
    // t1's tasks are created first; t2 then fails (build removed after preflight).
    state.afterPreflight = () => fs.rmSync(buildDir('t2'), { recursive: true, force: true });
    expect(() => launchRun(c.id, OPTS)).toThrow();
    expect(count('campaign_runs')).toBe(0);
    expect(count('tasks')).toBe(0);
    expect(count('run_notices')).toBe(0);
  });
});
