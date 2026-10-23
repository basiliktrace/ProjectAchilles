/**
 * Pre-execution notices: creation (Run Now / retry / scheduler tick) and the
 * send pass. All SQL is in notices.repo.ts.
 *
 * Import rule (Ruling R2): this module must not import
 * services/agent/tasks.service.ts.
 */
import crypto from 'crypto';
import { getDatabase } from '../agent/database.js';
import { randomWindowForDate, todayInTimezone } from '../agent/scheduleTime.js';
import { IntegrationsSettingsService } from '../integrations/settings.js';
import { sendMail } from '../alerts/email.service.js';
import type { OutgoingMail } from '../alerts/email.service.js';
import { sendSlackText } from '../alerts/slack.service.js';
import { isFullyAccepted } from './acceptance.js';
import { buildIcs } from './ics.js';
import { MAX_INLINE_HOSTS, buildHostsCsv, buildNoticeEmail } from './render.js';
import type { NoticeEmailData } from './render.js';
import { computeDayRelease, computeRunRelease, runTag } from './window.js';
import * as repo from './notices.repo.js';
import type { NoticeRow, NoticeSourceType } from './types.js';
import type { TaskPayload } from '../../types/agent.js';

const MIN = 60_000;
/** A claim older than this belongs to a crashed or hung sender and may be taken over. */
const STALE_CLAIM_MS = 5 * MIN;
/** Matches the heartbeat service's online/offline threshold. */
const ONLINE_THRESHOLD_MS = 180_000;
/** Used for window_end when no linked task carries an execution_timeout. */
const DEFAULT_EXECUTION_TIMEOUT_SEC = 300;

const SKIP_NO_TASKS = 'no tasks were created';
const SKIP_COLLISION = 'previous run still waiting for notice delivery';

export type SendOutcome = 'sent' | 'failed' | 'skipped' | 'not_claimed';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function settingsService(): IntegrationsSettingsService {
  // Deployment-wide settings: always the legacy top level (no org id).
  return new IntegrationsSettingsService();
}

/** A valid IANA timezone, or 'UTC' when `tz` is missing or invalid. */
export function safeTimezone(tz: string | null | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
    return tz;
  } catch {
    return 'UTC';
  }
}

function serverTimezone(): string {
  return safeTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
}

/** Base UI link (Ruling R3): first CORS_ORIGIN entry, else the Vite dev origin. */
function tasksUiUrl(): string {
  const first = (process.env.CORS_ORIGIN ?? '')
    .split(',')
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  const base = (first ?? 'http://localhost:5173').replace(/\/+$/, '');
  return `${base}/endpoints/tasks`;
}

/** Parses ISO strings and SQLite `YYYY-MM-DD HH:MM:SS` (UTC) timestamps. */
function parseTimestamp(s: string | null | undefined): number | null {
  if (!s) return null;
  const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const ms = Date.parse(normalised);
  return Number.isNaN(ms) ? null : ms;
}

function isOnline(lastHeartbeat: string | null, now: Date): boolean {
  const ms = parseTimestamp(lastHeartbeat);
  return ms !== null && now.getTime() - ms <= ONLINE_THRESHOLD_MS;
}

function parseJsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/** The gate applies to new runs when notices are enabled and SMTP is configured. */
export function isNoticeGateEnabled(): boolean {
  const svc = settingsService();
  if (!svc.getPreExecutionNoticeSettings().enabled) return false;
  return !!svc.getAlertSettings()?.email?.configured;
}

function recipientsSnapshot(): string[] {
  return [...settingsService().getPreExecutionNoticeSettings().recipients];
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

function fireSend(id: string): void {
  // Deferred so the caller's response is never blocked or failed by SMTP.
  void Promise.resolve()
    .then(() => sendNotice(id))
    .catch((err: unknown) => {
      console.error(`[Notices] send of ${runTag(id)} failed:`, err);
    });
}

/**
 * Run `fn` with a fresh pending run notice when the gate is enabled. The
 * notice insert and whatever `fn` writes share one transaction, so an error in
 * `fn` leaves no notice behind. After commit the first send attempt is fired
 * in the background; its errors are logged, never thrown to the caller.
 */
export function runWithNotice<T>(
  source: { type: NoticeSourceType; createdBy: string; timezone?: string },
  fn: (noticeId: string | null) => T,
): T {
  if (!isNoticeGateEnabled()) return fn(null);

  const db = getDatabase();
  const id = crypto.randomUUID();
  const recipients = recipientsSnapshot();
  const timezone = source.timezone ? safeTimezone(source.timezone) : serverTimezone();

  const result = db.transaction(() => {
    repo.insertNotice({
      id,
      kind: 'run',
      state: 'pending',
      sourceType: source.type,
      scheduleIds: [],
      timezone,
      createdBy: source.createdBy,
      createdAt: new Date().toISOString(),
      recipients,
    });
    return fn(id);
  })();

  fireSend(id);
  return result;
}

export interface DayNoticeSchedule {
  id: string;
  timezone: string;
  created_by: string;
  agent_next_runs: Record<string, string>;
  execution_timeout: number;
}

export interface SchedulerTick {
  runNoticeFor(scheduleId: string, timezone: string, createdBy: string): string | null;
  dayNoticeFor(schedule: DayNoticeSchedule): string | null;
  hasPendingRunNotice(scheduleId: string): boolean;
  recordSkippedOccurrence(scheduleId: string, createdBy: string, timezone: string): void;
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

/**
 * Per-tick notice factory for processSchedules. All non-per-machine batches
 * created in one tick share one run notice; per-machine schedules get one day
 * notice per schedule per calendar day (schedule timezone).
 */
export function createSchedulerTick(now: Date): SchedulerTick {
  const nowIso = now.toISOString();
  let gate: boolean | null = null;
  const gateEnabled = (): boolean => (gate ??= isNoticeGateEnabled());
  let runNoticeId: string | null = null;

  return {
    runNoticeFor(scheduleId, timezone, createdBy) {
      if (!gateEnabled()) return null;
      if (runNoticeId) {
        repo.appendScheduleId(runNoticeId, scheduleId);
        return runNoticeId;
      }
      const id = crypto.randomUUID();
      repo.insertNotice({
        id,
        kind: 'run',
        state: 'pending',
        sourceType: 'schedule',
        scheduleIds: [scheduleId],
        timezone: safeTimezone(timezone),
        createdBy,
        createdAt: nowIso,
        recipients: recipientsSnapshot(),
      });
      runNoticeId = id;
      return id;
    },

    dayNoticeFor(schedule) {
      if (!gateEnabled()) return null;
      const tz = safeTimezone(schedule.timezone);
      const windowDate = todayInTimezone(tz, now);
      const existing = repo.getDayNotice(schedule.id, windowDate);
      if (existing) return existing.id;

      const window = randomWindowForDate(windowDate, tz);
      const startMs = window.start.getTime();
      const endMs = window.end.getTime();
      const announced = Object.entries(schedule.agent_next_runs ?? {})
        .filter(([, at]) => {
          const ms = parseTimestamp(at);
          return ms !== null && ms >= startMs && ms <= endMs;
        })
        .map(([agentId]) => agentId);

      const id = crypto.randomUUID();
      try {
        repo.insertNotice({
          id,
          kind: 'day',
          state: 'pending',
          sourceType: 'schedule',
          scheduleIds: [schedule.id],
          scheduleId: schedule.id,
          windowDate,
          timezone: tz,
          announcedAgentIds: announced,
          dayWindowStart: window.start.toISOString(),
          dayWindowEnd: window.end.toISOString(),
          createdBy: schedule.created_by,
          createdAt: nowIso,
          recipients: recipientsSnapshot(),
        });
        return id;
      } catch (err) {
        // Another writer created today's notice first (idx_run_notices_day).
        if (!isUniqueViolation(err)) throw err;
        const raced = repo.getDayNotice(schedule.id, windowDate);
        if (!raced) throw err;
        return raced.id;
      }
    },

    hasPendingRunNotice(scheduleId) {
      return repo.hasPendingRunNoticeForSchedule(scheduleId);
    },

    recordSkippedOccurrence(scheduleId, createdBy, timezone) {
      repo.insertNotice({
        id: crypto.randomUUID(),
        kind: 'run',
        state: 'skipped',
        sourceType: 'schedule',
        scheduleIds: [scheduleId],
        timezone: safeTimezone(timezone),
        createdBy,
        createdAt: nowIso,
        recipients: recipientsSnapshot(),
        skipReason: SKIP_COLLISION,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Send pass
// ---------------------------------------------------------------------------

function triggerText(n: NoticeRow): string {
  switch (n.source_type) {
    case 'run_now':
      return `Run Now by ${n.created_by}`;
    case 'manual_retry':
      return `Manual retry by ${n.created_by}`;
    case 'schedule': {
      const ids = parseJsonArray(n.schedule_ids);
      if (ids.length === 0 && n.schedule_id) ids.push(n.schedule_id);
      const names = repo.getScheduleNames(ids);
      return ids.map((id) => `Schedule "${names.get(id) ?? id}"`).join(', ');
    }
    default:
      return n.created_by;
  }
}

function parsePayload(s: string): TaskPayload | null {
  try {
    return JSON.parse(s) as TaskPayload;
  } catch {
    return null;
  }
}

interface BuiltNotice {
  mail: OutgoingMail;
  pickupDeadline: Date;
  windowEnd: Date;
}

function buildNoticeMail(
  n: NoticeRow,
  linked: repo.LinkedTaskRow[],
  recipients: string[],
  now: Date,
): BuiltNotice {
  const svc = settingsService();
  const settings = svc.getPreExecutionNoticeSettings();
  const timezone = safeTimezone(n.timezone);
  const tag = runTag(n.id);

  // Tests: one entry per test_uuid, from the task payload metadata.
  const tests = new Map<string, NoticeEmailData['tests'][number]>();
  let maxTimeoutSec = 0;
  for (const t of linked) {
    const p = parsePayload(t.payload);
    if (!p) continue;
    if (typeof p.execution_timeout === 'number' && p.execution_timeout > maxTimeoutSec) {
      maxTimeoutSec = p.execution_timeout;
    }
    const key = p.test_uuid || p.test_name;
    if (tests.has(key)) continue;
    tests.set(key, {
      name: p.test_name || key,
      severity: p.metadata?.severity ?? '',
      category: p.metadata?.category ?? '',
      techniques: p.metadata?.techniques ?? [],
      tactics: p.metadata?.tactics ?? [],
    });
  }
  if (maxTimeoutSec === 0) maxTimeoutSec = DEFAULT_EXECUTION_TIMEOUT_SEC;

  // Hosts: agents with a linked task, plus (day notices) every announced agent.
  const hosts = new Map<string, NoticeEmailData['hosts'][number]>();
  for (const t of linked) {
    if (hosts.has(t.agent_id)) continue;
    hosts.set(t.agent_id, {
      hostname: t.hostname ?? t.agent_id,
      os: t.os ?? '',
      online: isOnline(t.last_heartbeat, now),
    });
  }
  if (n.kind === 'day') {
    const missing = parseJsonArray(n.announced_agent_ids).filter((a) => !hosts.has(a));
    for (const a of repo.getAgentHosts(missing)) {
      hosts.set(a.id, { hostname: a.hostname, os: a.os, online: isOnline(a.last_heartbeat, now) });
    }
  }
  const hostList = [...hosts.values()];

  // Window as announced if accepted now.
  let release: { releaseAt: Date; pickupDeadline: Date; windowEnd: Date };
  let dayWindow: { start: Date; end: Date } | undefined;
  if (n.kind === 'day' && n.day_window_start && n.day_window_end) {
    dayWindow = { start: new Date(n.day_window_start), end: new Date(n.day_window_end) };
    release = computeDayRelease(now, settings, dayWindow.end, maxTimeoutSec);
  } else {
    release = computeRunRelease(now, settings, maxTimeoutSec);
  }

  // EDR context.
  const edr: NoticeEmailData['edr'] = [];
  if (svc.isDefenderConfigured()) {
    edr.push({ vendor: 'Microsoft Defender', autoResolve: svc.getDefenderSettings()?.auto_resolve_mode ?? 'disabled' });
  }
  if (svc.isCrowdStrikeConfigured()) {
    edr.push({ vendor: 'CrowdStrike Falcon', autoResolve: svc.getCrowdStrikeAutoResolveMode() });
  }

  const trigger = triggerText(n);
  const data: NoticeEmailData = {
    kind: n.kind,
    runTag: tag,
    timezone,
    trigger,
    startNotBefore: release.releaseAt,
    pickupDeadline: release.pickupDeadline,
    windowEnd: release.windowEnd,
    ...(dayWindow ? { dayWindow } : {}),
    tests: [...tests.values()],
    hosts: hostList,
    edr,
    uiUrl: tasksUiUrl(),
  };
  const { subject, html } = buildNoticeEmail(data);

  const ics = buildIcs({
    uid: `${n.id}@projectachilles`,
    sequence: 0,
    start: release.releaseAt,
    end: release.windowEnd,
    summary: `ProjectAchilles security testing ${tag}`,
    description: `${trigger}. ${data.tests.length} test(s) on ${hostList.length} host(s). Search for ${tag} in your security tooling.`,
    stamp: now,
  });
  const attachments: NonNullable<OutgoingMail['attachments']> = [
    { filename: `${tag}.ics`, content: ics, contentType: 'text/calendar; charset=utf-8; method=PUBLISH' },
  ];
  if (hostList.length > MAX_INLINE_HOSTS) {
    attachments.push({ filename: `${tag}-hosts.csv`, content: buildHostsCsv(hostList), contentType: 'text/csv; charset=utf-8' });
  }

  return {
    mail: { to: recipients, subject, html, attachments },
    pickupDeadline: release.pickupDeadline,
    windowEnd: release.windowEnd,
  };
}

async function alertSlackOnFailure(n: NoticeRow, error: string): Promise<void> {
  if (n.slack_failure_alerted) return;
  const slack = settingsService().getAlertSettings()?.slack;
  if (!slack?.configured || !slack.enabled || !slack.webhook_url) return;
  // Take the once-per-notice flag atomically before sending, so two failing
  // senders can't both alert.
  if (!repo.claimSlackFailureAlert(n.id)) return;
  try {
    await sendSlackText(
      slack.webhook_url,
      `Notice ${runTag(n.id)} could not be sent: ${error}. Tests are waiting.`,
    );
  } catch (err) {
    // Unflag, so the next failure tries Slack again.
    repo.resetSlackFailureAlert(n.id);
    console.error(`[Notices] Slack alert for ${runTag(n.id)} failed:`, err);
  }
}

/**
 * One send attempt for a pending notice. Claims it atomically (a second
 * concurrent caller gets `not_claimed`), emails the recipients snapshot, and on
 * full acceptance marks it `sent` with release times counted from acceptance.
 * Every write after the claim is conditional on still owning it; a sender
 * whose stale claim was taken over gets `not_claimed` and writes nothing.
 */
export async function sendNotice(id: string, now?: Date): Promise<SendOutcome> {
  const start = now ?? new Date();
  const claimAt = start.toISOString();
  const staleCutoff = new Date(start.getTime() - STALE_CLAIM_MS);
  if (!repo.claimNotice(id, claimAt, staleCutoff.toISOString())) return 'not_claimed';

  const n = repo.getNotice(id);
  if (!n) return 'not_claimed';

  const linked = repo.getLinkedTasks(id);
  if (n.kind === 'run' && linked.length === 0) {
    // Orphan (e.g. createTasks threw after the notice was created): never email.
    return repo.markSkipped(id, claimAt, SKIP_NO_TASKS) ? 'skipped' : 'not_claimed';
  }
  if (linked.length === 0) {
    // Day notice with nothing linked yet: nothing to announce; try next tick.
    repo.releaseClaim(id, claimAt);
    return 'not_claimed';
  }

  const recipients = parseJsonArray(n.recipients);
  let accepted: string[] = [];
  let rejected: string[] = [];
  let error: string;
  try {
    const email = settingsService().getAlertSettings()?.email;
    if (!email?.configured) throw new Error('SMTP email is not configured');

    const built = buildNoticeMail(n, linked, recipients, start);
    const result = await sendMail(email, built.mail);
    accepted = result.accepted;
    rejected = result.rejected;

    if (isFullyAccepted(recipients, result)) {
      // The countdown starts at acceptance. The pickup deadline and window end
      // stay as announced in the email (never later than promised).
      const sentAt = now ?? new Date();
      const settings = settingsService().getPreExecutionNoticeSettings();
      const releaseAt = new Date(sentAt.getTime() + settings.lead_minutes * MIN);
      const applied = repo.markSent(id, claimAt, {
        sentAt: sentAt.toISOString(),
        accepted,
        rejected,
        releaseAt: releaseAt.toISOString(),
        pickupDeadline: built.pickupDeadline.toISOString(),
        windowEnd: built.windowEnd.toISOString(),
      });
      // Not applied: this sender lost the claim (stale takeover) or the notice
      // left 'pending' mid-send (admin override). The owner, if any, records it.
      return applied ? 'sent' : 'not_claimed';
    }

    if (rejected.length > 0) {
      error = `rejected: ${rejected.join(', ')}`;
    } else {
      const got = new Set(accepted.map((a) => a.trim().toLowerCase()));
      const missing = recipients.filter((r) => !got.has(r.trim().toLowerCase()));
      error = missing.length > 0 ? `not accepted: ${missing.join(', ')}` : 'no recipients accepted';
    }
  } catch (err) {
    error = errorMessage(err);
  }

  // A sender that lost its claim records nothing and alerts nobody.
  if (!repo.recordSendFailure(id, claimAt, error, accepted, rejected)) return 'not_claimed';
  await alertSlackOnFailure(n, error);
  return 'failed';
}
