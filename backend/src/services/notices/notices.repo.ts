/**
 * All SQL for pre-execution notices lives here.
 *
 * Import rule (Ruling R2): nothing under services/notices/ imports
 * services/agent/tasks.service.ts. Linked tasks are read with SQL below, and
 * tasks.service may import this module without creating an ESM cycle.
 *
 * Timestamps: every value written is a `Date.toISOString()` string (with
 * milliseconds) and every comparison uses a JS-computed ISO parameter, never
 * `datetime('now')`. The task hold compares these columns as strings.
 */
import { getDatabase } from '../agent/database.js';
import type { NoticeKind, NoticeRow, NoticeSourceType, NoticeState } from './types.js';

export interface NewNotice {
  id: string;
  kind: NoticeKind;
  state: NoticeState;
  sourceType: NoticeSourceType;
  scheduleIds: string[];
  scheduleId?: string | null;
  windowDate?: string | null;
  timezone: string;
  announcedAgentIds?: string[];
  dayWindowStart?: string | null;
  dayWindowEnd?: string | null;
  createdBy: string;
  createdAt: string;
  recipients: string[];
  skipReason?: string | null;
}

export function insertNotice(n: NewNotice): void {
  getDatabase()
    .prepare(`
      INSERT INTO run_notices (id, kind, state, source_type, schedule_ids, schedule_id, window_date, timezone,
        announced_agent_ids, day_window_start, day_window_end, created_by, created_at, recipients, skip_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      n.id,
      n.kind,
      n.state,
      n.sourceType,
      JSON.stringify(n.scheduleIds),
      n.scheduleId ?? null,
      n.windowDate ?? null,
      n.timezone,
      JSON.stringify(n.announcedAgentIds ?? []),
      n.dayWindowStart ?? null,
      n.dayWindowEnd ?? null,
      n.createdBy,
      n.createdAt,
      JSON.stringify(n.recipients),
      n.skipReason ?? null,
    );
}

export function getNotice(id: string): NoticeRow | null {
  const row = getDatabase().prepare('SELECT * FROM run_notices WHERE id = ?').get(id) as NoticeRow | undefined;
  return row ?? null;
}

export function getDayNotice(scheduleId: string, windowDate: string): NoticeRow | null {
  const row = getDatabase()
    .prepare(`SELECT * FROM run_notices WHERE kind = 'day' AND schedule_id = ? AND window_date = ?`)
    .get(scheduleId, windowDate) as NoticeRow | undefined;
  return row ?? null;
}

/** Append a schedule id to a run notice's `schedule_ids` (no-op if already listed). */
export function appendScheduleId(noticeId: string, scheduleId: string): void {
  getDatabase()
    .prepare(`
      UPDATE run_notices
      SET schedule_ids = json_insert(schedule_ids, '$[#]', ?)
      WHERE id = ? AND NOT EXISTS (SELECT 1 FROM json_each(run_notices.schedule_ids) WHERE value = ?)
    `)
    .run(scheduleId, noticeId, scheduleId);
}

export function hasPendingRunNoticeForSchedule(scheduleId: string): boolean {
  const row = getDatabase()
    .prepare(`
      SELECT 1 FROM run_notices
      WHERE kind = 'run' AND state = 'pending'
        AND EXISTS (SELECT 1 FROM json_each(run_notices.schedule_ids) WHERE value = ?)
      LIMIT 1
    `)
    .get(scheduleId);
  return row !== undefined;
}

/**
 * Atomically claim a pending notice for sending. A claim older than
 * `staleCutoffIso` (a crashed or hung sender) can be taken over.
 */
export function claimNotice(id: string, nowIso: string, staleCutoffIso: string): boolean {
  const res = getDatabase()
    .prepare(`
      UPDATE run_notices SET claim_at = ?
      WHERE id = ? AND state = 'pending' AND (claim_at IS NULL OR claim_at < ?)
    `)
    .run(nowIso, id, staleCutoffIso);
  return res.changes > 0;
}

export function releaseClaim(id: string): void {
  getDatabase().prepare('UPDATE run_notices SET claim_at = NULL WHERE id = ?').run(id);
}

export function markSkipped(id: string, reason: string): void {
  getDatabase()
    .prepare(`UPDATE run_notices SET state = 'skipped', skip_reason = ?, claim_at = NULL WHERE id = ? AND state = 'pending'`)
    .run(reason, id);
}

export function markSent(
  id: string,
  v: {
    sentAt: string;
    accepted: string[];
    rejected: string[];
    releaseAt: string;
    pickupDeadline: string;
    windowEnd: string;
  },
): boolean {
  const res = getDatabase()
    .prepare(`
      UPDATE run_notices
      SET state = 'sent', sent_at = ?, accepted = ?, rejected = ?, attempts = attempts + 1,
          last_error = NULL, release_at = ?, pickup_deadline = ?, window_end = ?, claim_at = NULL
      WHERE id = ? AND state = 'pending'
    `)
    .run(
      v.sentAt,
      JSON.stringify(v.accepted),
      JSON.stringify(v.rejected),
      v.releaseAt,
      v.pickupDeadline,
      v.windowEnd,
      id,
    );
  return res.changes > 0;
}

export function recordSendFailure(id: string, error: string, accepted: string[], rejected: string[]): void {
  getDatabase()
    .prepare(`
      UPDATE run_notices
      SET attempts = attempts + 1, last_error = ?, accepted = ?, rejected = ?, claim_at = NULL
      WHERE id = ?
    `)
    .run(error, JSON.stringify(accepted), JSON.stringify(rejected), id);
}

export function markSlackFailureAlerted(id: string): void {
  getDatabase().prepare('UPDATE run_notices SET slack_failure_alerted = 1 WHERE id = ?').run(id);
}

export interface LinkedTaskRow {
  id: string;
  agent_id: string;
  status: string;
  payload: string;
  hostname: string | null;
  os: string | null;
  last_heartbeat: string | null;
}

/** Tasks linked to a notice, with their agent's host details. */
export function getLinkedTasks(noticeId: string): LinkedTaskRow[] {
  return getDatabase()
    .prepare(`
      SELECT t.id, t.agent_id, t.status, t.payload, a.hostname, a.os, a.last_heartbeat
      FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id
      WHERE t.notice_id = ?
      ORDER BY t.created_at ASC, t.id ASC
    `)
    .all(noticeId) as LinkedTaskRow[];
}

export interface AgentHostRow {
  id: string;
  hostname: string;
  os: string;
  last_heartbeat: string | null;
}

export function getAgentHosts(agentIds: string[]): AgentHostRow[] {
  if (agentIds.length === 0) return [];
  const placeholders = agentIds.map(() => '?').join(', ');
  return getDatabase()
    .prepare(`SELECT id, hostname, os, last_heartbeat FROM agents WHERE id IN (${placeholders})`)
    .all(...agentIds) as AgentHostRow[];
}

export function getScheduleNames(scheduleIds: string[]): Map<string, string | null> {
  if (scheduleIds.length === 0) return new Map();
  const placeholders = scheduleIds.map(() => '?').join(', ');
  const rows = getDatabase()
    .prepare(`SELECT id, name FROM schedules WHERE id IN (${placeholders})`)
    .all(...scheduleIds) as Array<{ id: string; name: string | null }>;
  return new Map(rows.map((r) => [r.id, r.name]));
}
