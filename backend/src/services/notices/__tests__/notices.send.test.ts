import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { createTestDatabase, insertTestAgent, insertTestTask } from '../../../__tests__/helpers/db.js';

let testDb: Database.Database;

vi.mock('../../agent/database.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent/database.js')>();
  return { ...actual, getDatabase: () => testDb };
});

vi.mock('../../agent/test-catalog.service.js', () => ({
  getTestMetadata: () => null,
}));

// Settings are read from a real integrations.json under a temp HOME.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const home = `${actual.tmpdir()}/pa-notices-send-${process.pid}`;
  const overrides = { homedir: () => home };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

const { mockSendMail, mockSendSlackText } = vi.hoisted(() => ({
  mockSendMail: vi.fn(),
  mockSendSlackText: vi.fn(),
}));

vi.mock('../../alerts/email.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../alerts/email.service.js')>();
  return { ...actual, sendMail: mockSendMail };
});

vi.mock('../../alerts/slack.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../alerts/slack.service.js')>();
  return { ...actual, sendSlackText: mockSendSlackText };
});

const {
  isNoticeGateEnabled,
  runWithNotice,
  sendNotice,
  createSchedulerTick,
} = await import('../notices.service.js');
const { getNextTask, resetExpireThrottle } = await import('../../agent/tasks.service.js');

// Friday, inside the 09:00-17:00 weekday window in UTC.
const NOW = new Date('2026-10-23T12:00:00.000Z');
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
const MIN = 60_000;
const RECIPIENTS = ['a@x.com', 'b@x.com'];

const HOME = os.homedir();
const SETTINGS_DIR = path.join(HOME, '.projectachilles');

function writeSettings(opts: { enabled?: boolean; emailConfigured?: boolean; slack?: boolean } = {}) {
  const { enabled = true, emailConfigured = true, slack = false } = opts;
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
          smtp_user: 'user',
          smtp_pass: 'pass',
          from_address: 'pa@example.test',
          recipients: [],
          configured: emailConfigured,
          enabled: true,
        },
        ...(slack
          ? { slack: { webhook_url: 'https://hooks.slack.test/abc', configured: true, enabled: true } }
          : {}),
      },
      pre_execution_notices: {
        enabled,
        recipients: RECIPIENTS,
        lead_minutes: 5,
        max_wait_minutes: 60,
        pickup_window_minutes: 120,
        send_finished: true,
      },
    }),
  );
}

function insertPendingNotice(id: string, extra: Record<string, unknown> = {}) {
  const row = {
    id,
    kind: 'run',
    state: 'pending',
    source_type: 'run_now',
    schedule_ids: '[]',
    schedule_id: null,
    window_date: null,
    timezone: 'UTC',
    announced_agent_ids: '[]',
    day_window_start: null,
    day_window_end: null,
    created_by: 'alice',
    created_at: at(-MIN).toISOString(),
    recipients: JSON.stringify(RECIPIENTS),
    claim_at: null,
    ...extra,
  };
  testDb.prepare(`
    INSERT INTO run_notices (id, kind, state, source_type, schedule_ids, schedule_id, window_date, timezone,
      announced_agent_ids, day_window_start, day_window_end, created_by, created_at, recipients, claim_at)
    VALUES (@id, @kind, @state, @source_type, @schedule_ids, @schedule_id, @window_date, @timezone,
      @announced_agent_ids, @day_window_start, @day_window_end, @created_by, @created_at, @recipients, @claim_at)
  `).run(row);
}

function linkTask(taskId: string, noticeId: string, agentId = 'agent-001', payloadExtra: Record<string, unknown> = {}) {
  const payload = JSON.stringify({
    test_uuid: 'test-uuid-001',
    test_name: 'Credential Dumping <script>',
    binary_name: 'test.exe',
    binary_sha256: 'abc',
    binary_size: 1,
    execution_timeout: 300,
    arguments: [],
    metadata: {
      category: 'intel-driven', subcategory: '', severity: 'high',
      techniques: ['T1003'], tactics: ['credential-access'],
      threat_actor: '', target: [], complexity: '', tags: [], score: null, integrations: [],
    },
    ...payloadExtra,
  });
  insertTestTask(testDb, { id: taskId, agent_id: agentId, payload });
  testDb.prepare('UPDATE tasks SET notice_id = ? WHERE id = ?').run(noticeId, taskId);
}

function notice(id: string): Record<string, unknown> {
  return testDb.prepare('SELECT * FROM run_notices WHERE id = ?').get(id) as Record<string, unknown>;
}

function countNotices(): number {
  return (testDb.prepare('SELECT COUNT(*) AS c FROM run_notices').get() as { c: number }).c;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('pre-execution notice creation and send pass', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testDb = createTestDatabase();
    resetExpireThrottle();
    insertTestAgent(testDb, { id: 'agent-001', hostname: 'host-1', last_heartbeat: at(-30_000).toISOString() });
    writeSettings();
    mockSendMail.mockResolvedValue({ accepted: [...RECIPIENTS], rejected: [] });
    mockSendSlackText.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.CORS_ORIGIN;
  });

  afterAll(() => {
    fs.rmSync(HOME, { recursive: true, force: true });
  });

  describe('runWithNotice', () => {
    it('gate disabled: calls fn(null) and creates no notice', () => {
      writeSettings({ enabled: false });
      expect(isNoticeGateEnabled()).toBe(false);
      const fn = vi.fn((nid: string | null) => nid);
      expect(runWithNotice({ type: 'run_now', createdBy: 'alice' }, fn)).toBeNull();
      expect(fn).toHaveBeenCalledWith(null);
      expect(countNotices()).toBe(0);
    });

    it('gate is disabled when SMTP is not configured, even if notices are enabled', () => {
      writeSettings({ enabled: true, emailConfigured: false });
      expect(isNoticeGateEnabled()).toBe(false);
    });

    it('gate enabled: the notice row exists in the same transaction as the tasks fn inserted', async () => {
      expect(isNoticeGateEnabled()).toBe(true);
      const result = runWithNotice({ type: 'run_now', createdBy: 'alice' }, (nid) => {
        expect(nid).toEqual(expect.any(String));
        // Visible inside the transaction.
        expect(notice(nid!)).toMatchObject({ state: 'pending', kind: 'run', source_type: 'run_now', created_by: 'alice' });
        linkTask('t1', nid!);
        return nid;
      });
      const n = notice(result!);
      expect(JSON.parse(n.recipients as string)).toEqual(RECIPIENTS);
      expect(n.created_at).toMatch(/\.\d{3}Z$/);
      const task = testDb.prepare('SELECT notice_id FROM tasks WHERE id = ?').get('t1') as { notice_id: string };
      expect(task.notice_id).toBe(result);
      await flush();
    });

    it('an exception in fn rolls back the notice row and propagates', async () => {
      expect(() =>
        runWithNotice({ type: 'run_now', createdBy: 'alice' }, (nid) => {
          linkTask('t1', nid!);
          throw new Error('No binary was built for OS windows');
        }),
      ).toThrow('No binary was built');
      expect(countNotices()).toBe(0);
      expect(testDb.prepare('SELECT COUNT(*) AS c FROM tasks').get()).toEqual({ c: 0 });
      await flush();
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    it('fires the send after commit and never throws a send error to the caller', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockSendMail.mockRejectedValue(new Error('Invalid login'));
      const id = runWithNotice({ type: 'run_now', createdBy: 'alice' }, (nid) => {
        linkTask('t1', nid!);
        return nid!;
      });
      await flush();
      await flush();
      expect(mockSendMail).toHaveBeenCalledTimes(1);
      expect(notice(id)).toMatchObject({ state: 'pending', attempts: 1, last_error: 'Invalid login' });
      errSpy.mockRestore();
    });
  });

  describe('sendNotice', () => {
    it('accepted: marks sent, release_at = sent_at + 5m, and the task becomes pickable at release', async () => {
      insertPendingNotice('n1');
      linkTask('t1', 'n1');

      expect(await sendNotice('n1', NOW)).toBe('sent');

      const n = notice('n1');
      expect(n.state).toBe('sent');
      expect(n.sent_at).toBe(NOW.toISOString());
      expect(n.release_at).toBe(at(5 * MIN).toISOString());
      expect(n.pickup_deadline).toBe(at(125 * MIN).toISOString());
      expect(n.window_end).toBe(at(125 * MIN + 300_000).toISOString());
      expect(n.claim_at).toBeNull();
      expect(JSON.parse(n.accepted as string)).toEqual(RECIPIENTS);

      const mail = mockSendMail.mock.calls[0][1];
      expect(mail.to).toEqual(RECIPIENTS);
      expect(mail.html).toContain('Credential Dumping &lt;script&gt;');
      expect(mail.html).toContain('Run Now by alice');
      expect(mail.html).toContain('host-1');
      expect(mail.attachments.map((a: { filename: string }) => a.filename)).toEqual([
        expect.stringMatching(/\.ics$/),
      ]);
      expect(mail.attachments[0].content).toContain('UID:n1@projectachilles');

      expect(getNextTask('agent-001', at(5 * MIN - 1000))).toBeNull();
      expect(getNextTask('agent-001', at(5 * MIN))?.id).toBe('t1');
    });

    it('links to the tasks page from the first CORS_ORIGIN entry', async () => {
      process.env.CORS_ORIGIN = 'https://pa.example.test,https://other.example.test';
      insertPendingNotice('n1');
      linkTask('t1', 'n1');
      await sendNotice('n1', NOW);
      expect(mockSendMail.mock.calls[0][1].html).toContain('https://pa.example.test/endpoints/tasks');
    });

    it('falls back to localhost:5173 when CORS_ORIGIN is unset', async () => {
      insertPendingNotice('n1');
      linkTask('t1', 'n1');
      await sendNotice('n1', NOW);
      expect(mockSendMail.mock.calls[0][1].html).toContain('http://localhost:5173/endpoints/tasks');
    });

    it('two concurrent sends call sendMail once (Review Focus 2)', async () => {
      insertPendingNotice('n1');
      linkTask('t1', 'n1');
      const results = await Promise.all([sendNotice('n1', NOW), sendNotice('n1', NOW)]);
      expect(results.sort()).toEqual(['not_claimed', 'sent']);
      expect(mockSendMail).toHaveBeenCalledTimes(1);
    });

    it('a claim 3 minutes old is reclaimable; 1 minute old is not', async () => {
      insertPendingNotice('stale', { claim_at: at(-3 * MIN).toISOString() });
      linkTask('t1', 'stale');
      insertPendingNotice('fresh', { claim_at: at(-1 * MIN).toISOString() });
      linkTask('t2', 'fresh');

      expect(await sendNotice('fresh', NOW)).toBe('not_claimed');
      expect(mockSendMail).not.toHaveBeenCalled();
      expect(await sendNotice('stale', NOW)).toBe('sent');
      expect(mockSendMail).toHaveBeenCalledTimes(1);
    });

    it('partial rejection keeps the notice pending and the task held (Review Focus 3)', async () => {
      mockSendMail.mockResolvedValue({ accepted: ['a@x.com'], rejected: ['b@x.com'] });
      insertPendingNotice('n1');
      linkTask('t1', 'n1');

      expect(await sendNotice('n1', NOW)).toBe('failed');

      const n = notice('n1');
      expect(n.state).toBe('pending');
      expect(n.attempts).toBe(1);
      expect(n.last_error).toContain('b@x.com');
      expect(n.claim_at).toBeNull();
      expect(n.release_at).toBeNull();
      expect(getNextTask('agent-001', at(60 * MIN))).toBeNull();
    });

    it('a send error records attempts and alerts Slack once per notice', async () => {
      writeSettings({ slack: true });
      mockSendMail.mockRejectedValue(new Error('Invalid login'));
      insertPendingNotice('7f3c9a00-0000-0000-0000-000000000000');
      linkTask('t1', '7f3c9a00-0000-0000-0000-000000000000');
      const id = '7f3c9a00-0000-0000-0000-000000000000';

      expect(await sendNotice(id, NOW)).toBe('failed');
      expect(notice(id)).toMatchObject({ state: 'pending', attempts: 1, last_error: 'Invalid login', slack_failure_alerted: 1 });
      expect(mockSendSlackText).toHaveBeenCalledTimes(1);
      expect(mockSendSlackText).toHaveBeenCalledWith(
        'https://hooks.slack.test/abc',
        'Notice PA-RUN-7f3c9a could not be sent: Invalid login. Tests are waiting.',
      );

      expect(await sendNotice(id, at(MIN))).toBe('failed');
      expect(notice(id)).toMatchObject({ attempts: 2 });
      expect(mockSendSlackText).toHaveBeenCalledTimes(1);
    });

    it('does not alert Slack when Slack is not configured', async () => {
      mockSendMail.mockRejectedValue(new Error('Invalid login'));
      insertPendingNotice('n1');
      linkTask('t1', 'n1');
      await sendNotice('n1', NOW);
      expect(mockSendSlackText).not.toHaveBeenCalled();
      expect(notice('n1').slack_failure_alerted).toBe(0);
    });

    it('a run notice with no linked tasks is skipped and never emailed (Review Focus 4)', async () => {
      insertPendingNotice('orphan', { source_type: 'schedule', schedule_ids: '["s1"]' });
      expect(await sendNotice('orphan', NOW)).toBe('skipped');
      expect(notice('orphan')).toMatchObject({ state: 'skipped', skip_reason: 'no tasks were created', claim_at: null });
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    it('a notice that is not pending is not claimed', async () => {
      insertPendingNotice('n1', { state: 'sent' });
      linkTask('t1', 'n1');
      expect(await sendNotice('n1', NOW)).toBe('not_claimed');
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    it('an invalid timezone falls back to UTC instead of failing the send', async () => {
      insertPendingNotice('n1', { timezone: 'Not/AZone' });
      linkTask('t1', 'n1');
      expect(await sendNotice('n1', NOW)).toBe('sent');
      expect(mockSendMail.mock.calls[0][1].subject).toContain('UTC');
    });

    it('schedule trigger names every schedule on a batched tick notice', async () => {
      testDb.prepare(`
        INSERT INTO schedules (id, name, agent_ids, org_id, test_uuid, test_name, binary_name, schedule_type, schedule_config, created_by)
        VALUES ('s1', 'Nightly', '[]', 'org-001', 'u', 'n', 'b', 'daily', '{}', 'bob'),
               ('s2', NULL, '[]', 'org-001', 'u', 'n', 'b', 'daily', '{}', 'bob')
      `).run();
      insertPendingNotice('n1', { source_type: 'schedule', schedule_ids: '["s1","s2"]', created_by: 'bob' });
      linkTask('t1', 'n1');
      await sendNotice('n1', NOW);
      const html = mockSendMail.mock.calls[0][1].html as string;
      expect(html).toContain('Schedule &quot;Nightly&quot;, Schedule &quot;s2&quot;');
    });

    it('manual retry trigger text', async () => {
      insertPendingNotice('n1', { source_type: 'manual_retry', created_by: 'carol' });
      linkTask('t1', 'n1');
      await sendNotice('n1', NOW);
      expect(mockSendMail.mock.calls[0][1].html).toContain('Manual retry by carol');
    });

    it('uses the longest linked execution_timeout for window_end', async () => {
      insertTestAgent(testDb, { id: 'agent-002', hostname: 'host-2' });
      insertPendingNotice('n1');
      linkTask('t1', 'n1');
      linkTask('t2', 'n1', 'agent-002', { execution_timeout: 900 });
      await sendNotice('n1', NOW);
      expect(notice('n1').window_end).toBe(at(125 * MIN + 900_000).toISOString());
    });

    it('attaches the full host list as CSV when over 50 hosts', async () => {
      insertPendingNotice('n1');
      for (let i = 0; i < 51; i++) {
        const agentId = `bulk-${i}`;
        insertTestAgent(testDb, { id: agentId, hostname: `bulk-host-${i}` });
        linkTask(`bt-${i}`, 'n1', agentId);
      }
      await sendNotice('n1', NOW);
      const mail = mockSendMail.mock.calls[0][1];
      const csv = mail.attachments.find((a: { filename: string }) => a.filename.endsWith('.csv'));
      expect(csv).toBeDefined();
      expect(csv.content).toContain('bulk-host-50');
    });

    it('day notice: release via computeDayRelease (pickup deadline = day window end)', async () => {
      insertTestAgent(testDb, { id: 'agent-002', hostname: 'announced-host', last_heartbeat: at(-10 * MIN).toISOString() });
      insertPendingNotice('d1', {
        kind: 'day',
        source_type: 'schedule',
        schedule_ids: '["s1"]',
        schedule_id: 's1',
        window_date: '2026-10-23',
        announced_agent_ids: '["agent-001","agent-002"]',
        day_window_start: '2026-10-23T09:00:00.000Z',
        day_window_end: '2026-10-23T17:00:00.000Z',
      });
      linkTask('t1', 'd1');
      expect(await sendNotice('d1', NOW)).toBe('sent');
      const n = notice('d1');
      expect(n.release_at).toBe(at(5 * MIN).toISOString());
      expect(n.pickup_deadline).toBe('2026-10-23T17:00:00.000Z');
      expect(n.window_end).toBe(new Date(Date.parse('2026-10-23T17:00:00.000Z') + 300_000).toISOString());
      const html = mockSendMail.mock.calls[0][1].html as string;
      expect(html).toContain('announced-host');
      expect(html).toContain('Hosts (2)');
    });
  });

  describe('scheduler tick', () => {
    it('two runNoticeFor calls in one tick share one notice listing both schedules', () => {
      const tick = createSchedulerTick(NOW);
      const a = tick.runNoticeFor('s1', 'UTC', 'bob');
      const b = tick.runNoticeFor('s2', 'America/New_York', 'bob');
      expect(a).toEqual(expect.any(String));
      expect(b).toBe(a);
      const n = notice(a!);
      expect(JSON.parse(n.schedule_ids as string)).toEqual(['s1', 's2']);
      expect(n).toMatchObject({ kind: 'run', state: 'pending', source_type: 'schedule', timezone: 'UTC', created_at: NOW.toISOString() });

      const other = createSchedulerTick(at(MIN)).runNoticeFor('s1', 'UTC', 'bob');
      expect(other).not.toBe(a);
    });

    it('runNoticeFor and dayNoticeFor return null when the gate is disabled', () => {
      writeSettings({ enabled: false });
      const tick = createSchedulerTick(NOW);
      expect(tick.runNoticeFor('s1', 'UTC', 'bob')).toBeNull();
      expect(
        tick.dayNoticeFor({ id: 's1', timezone: 'UTC', created_by: 'bob', agent_next_runs: {}, execution_timeout: 300 }),
      ).toBeNull();
      expect(countNotices()).toBe(0);
    });

    it('hasPendingRunNotice reflects pending run notices containing the schedule', () => {
      const tick = createSchedulerTick(NOW);
      expect(tick.hasPendingRunNotice('s1')).toBe(false);
      const id = tick.runNoticeFor('s1', 'UTC', 'bob')!;
      tick.runNoticeFor('s2', 'UTC', 'bob');
      expect(tick.hasPendingRunNotice('s1')).toBe(true);
      expect(tick.hasPendingRunNotice('s2')).toBe(true);
      expect(tick.hasPendingRunNotice('s3')).toBe(false);
      testDb.prepare(`UPDATE run_notices SET state = 'sent' WHERE id = ?`).run(id);
      expect(tick.hasPendingRunNotice('s1')).toBe(false);
    });

    it('recordSkippedOccurrence inserts a skipped run notice', () => {
      const tick = createSchedulerTick(NOW);
      tick.recordSkippedOccurrence('s1', 'bob', 'UTC');
      const rows = testDb.prepare('SELECT * FROM run_notices').all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: 'run',
        state: 'skipped',
        skip_reason: 'previous run still waiting for notice delivery',
        schedule_ids: '["s1"]',
        created_by: 'bob',
        created_at: NOW.toISOString(),
      });
      expect(tick.hasPendingRunNotice('s1')).toBe(false);
    });

    it('dayNoticeFor: same schedule and day -> same id; different day -> different id', () => {
      const schedule = {
        id: 's1',
        timezone: 'UTC',
        created_by: 'bob',
        agent_next_runs: {
          'agent-in-1': '2026-10-23T11:59:00.000Z',
          'agent-in-2': '2026-10-23T16:30:00.000Z',
          'agent-tomorrow': '2026-10-24T10:00:00.000Z',
          'agent-early': '2026-10-23T08:00:00.000Z',
        },
        execution_timeout: 300,
      };
      const first = createSchedulerTick(NOW).dayNoticeFor(schedule);
      const again = createSchedulerTick(at(30 * MIN)).dayNoticeFor(schedule);
      expect(first).toEqual(expect.any(String));
      expect(again).toBe(first);

      const n = notice(first!);
      expect(n).toMatchObject({
        kind: 'day',
        state: 'pending',
        schedule_id: 's1',
        window_date: '2026-10-23',
        day_window_start: '2026-10-23T09:00:00.000Z',
        day_window_end: '2026-10-23T17:00:00.000Z',
        created_at: NOW.toISOString(),
      });
      expect(JSON.parse(n.announced_agent_ids as string).sort()).toEqual(['agent-in-1', 'agent-in-2']);

      const nextDay = createSchedulerTick(at(24 * 60 * MIN)).dayNoticeFor(schedule);
      expect(nextDay).not.toBe(first);
      expect(notice(nextDay!).window_date).toBe('2026-10-24');
    });

    it('dayNoticeFor with an invalid timezone falls back to UTC', () => {
      const id = createSchedulerTick(NOW).dayNoticeFor({
        id: 's1', timezone: 'Not/AZone', created_by: 'bob', agent_next_runs: {}, execution_timeout: 300,
      });
      expect(notice(id!)).toMatchObject({ timezone: 'UTC', window_date: '2026-10-23' });
    });
  });
});
