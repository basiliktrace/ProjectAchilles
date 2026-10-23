import { AppError } from '../../middleware/error.middleware.js';
import { getDatabase } from '../agent/database.js';
import { getNoticeRecord, getNoticeSummaries } from '../notices/notices.repo.js';
import { classifyOutcome, csvCell } from '../notices/render.js';
import type { NoticeRecord, NoticeScope, NoticeSummary } from '../notices/types.js';
import type { TaskResult, TaskStatus } from '../../types/agent.js';
import type { CampaignRunRow, CellState, RunSnapshot } from './types.js';

export interface MatrixCell {
  state: CellState;
  exit_code: number | null;
  task_id: string | null;
  completed_at: string | null;
  reason: string | null;
  /** payload.metadata.techniques of the latest attempt (for the CSV) */
  techniques: string[];
}

export interface RunMatrix {
  run: {
    id: string;
    campaign_id: string;
    campaign_name: string;
    framework_label: string | null;
    started_by: string;
    /** Display name from the run snapshot; started_by for runs without one. */
    started_by_name: string;
    started_at: string;
    /** The run's notice with its delivery record (sent at, recipients, override). */
    notice: NoticeRecord | null;
  };
  tests: { uuid: string; name: string }[];
  agents: { id: string; hostname: string; os: string }[];
  cells: Record<string, Record<string, MatrixCell>>;
  totals: Record<CellState, number> & { percent_protected: number | null };
  as_of: string;
}

interface PairTask {
  id: string;
  agent_id: string;
  test_uuid: string;
  status: TaskStatus;
  exit_code: number | null;
  error: string | null;
  /** JSON array text from payload.metadata.techniques */
  techniques: string | null;
  completed_at: string | null;
  notice_id: string | null;
}

const STATES: CellState[] = ['waiting_for_notice', 'running', 'protected', 'unprotected', 'error', 'not_run', 'na'];

function findRun(runId: string, callerOrg: string | undefined): CampaignRunRow {
  const db = getDatabase();
  const row = (callerOrg !== undefined
    ? db.prepare('SELECT * FROM campaign_runs WHERE id = ? AND org_id = ?').get(runId, callerOrg)
    : db.prepare('SELECT * FROM campaign_runs WHERE id = ?').get(runId)) as CampaignRunRow | undefined;
  if (!row) throw new AppError('Campaign run not found', 404);
  return row;
}

/** Latest attempt per (test, agent) pair in the run: retries inherit campaign_run_id. */
function latestTasksByPair(runId: string): Map<string, PairTask> {
  // Only the latest attempt per pair, and only the small fields the matrix needs:
  // result stdout/stderr can be ~1 MB each and must never be loaded here.
  const rows = getDatabase()
    .prepare(
      `SELECT id, agent_id, test_uuid, status, exit_code, error, techniques, completed_at, notice_id FROM (
         SELECT id, agent_id, json_extract(payload, '$.test_uuid') AS test_uuid, status,
                json_extract(result, '$.exit_code') AS exit_code,
                json_extract(result, '$.error') AS error,
                json_extract(payload, '$.metadata.techniques') AS techniques,
                completed_at, notice_id,
                ROW_NUMBER() OVER (
                  PARTITION BY json_extract(payload, '$.test_uuid'), agent_id
                  ORDER BY created_at DESC, rowid DESC) AS rn
         FROM tasks WHERE campaign_run_id = ?
       ) WHERE rn = 1`,
    )
    .all(runId) as PairTask[];
  const out = new Map<string, PairTask>();
  for (const r of rows) out.set(`${r.test_uuid}\u0000${r.agent_id}`, r);
  return out;
}

function noticeReleased(n: NoticeSummary | undefined, nowIso: string): boolean {
  return !!n && (n.state === 'sent' || n.state === 'overridden') && n.release_at !== null && n.release_at <= nowIso;
}

function parseTechniques(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function cellFor(task: PairTask, notices: Record<string, NoticeSummary>, nowIso: string): MatrixCell {
  const base = { exit_code: task.exit_code, task_id: task.id, completed_at: task.completed_at, reason: null as string | null, techniques: parseTechniques(task.techniques) };
  let state: CellState;
  switch (task.status) {
    case 'pending':
      state = task.notice_id && !noticeReleased(notices[task.notice_id], nowIso) ? 'waiting_for_notice' : 'running';
      break;
    case 'assigned':
    case 'downloading':
    case 'executing':
      state = 'running';
      break;
    case 'completed': {
      const o = classifyOutcome({
        status: task.status,
        result: task.exit_code === null ? null : ({ exit_code: task.exit_code } as TaskResult),
      });
      state = o === 'notRun' ? 'not_run' : o;
      break;
    }
    case 'failed':
      state = 'error';
      break;
    default:
      state = 'not_run'; // expired
  }
  // The reason a pair did not produce a verdict (expiry, cancel, agent error).
  if (state === 'not_run' || state === 'error') base.reason = task.error;
  return { state, ...base };
}

function totalsOf(cells: Record<string, Record<string, MatrixCell>>): RunMatrix['totals'] {
  const t = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<CellState, number>;
  for (const row of Object.values(cells)) for (const c of Object.values(row)) t[c.state]++;
  const denom = t.protected + t.unprotected;
  return { ...t, percent_protected: denom === 0 ? null : Math.round((t.protected / denom) * 100) };
}

function startedByName(row: CampaignRunRow, snap: RunSnapshot): string {
  return snap.started_by_name || row.started_by;
}

function build(row: CampaignRunRow): RunMatrix {
  const snap = JSON.parse(row.snapshot) as RunSnapshot;
  const nowIso = new Date().toISOString();
  const byPair = latestTasksByPair(row.id);
  const skipped = new Map(snap.skipped.map((s) => [`${s.test_uuid}\u0000${s.agent_id}`, s.reason]));
  const noticeIds = [...byPair.values()].map((t) => t.notice_id).filter((id): id is string => !!id);
  const scope: NoticeScope = { kind: 'org', orgId: row.org_id };
  const notices = getNoticeSummaries(noticeIds, scope);

  const cells: RunMatrix['cells'] = {};
  for (const t of snap.tests) {
    cells[t.uuid] = {};
    for (const a of snap.agents) {
      const key = `${t.uuid}\u0000${a.id}`;
      const reason = skipped.get(key);
      const task = byPair.get(key);
      cells[t.uuid][a.id] = reason !== undefined
        ? { state: 'na', exit_code: null, task_id: null, completed_at: null, reason, techniques: [] }
        : task
          ? cellFor(task, notices, nowIso)
          : { state: 'not_run', exit_code: null, task_id: null, completed_at: null, reason: null, techniques: [] };
    }
  }
  return {
    run: {
      id: row.id,
      campaign_id: row.campaign_id,
      campaign_name: snap.campaign_name,
      framework_label: snap.framework_label,
      started_by: row.started_by,
      started_by_name: startedByName(row, snap),
      started_at: row.started_at,
      notice: row.notice_id ? getNoticeRecord(row.notice_id, scope) : null,
    },
    tests: snap.tests,
    agents: snap.agents,
    cells,
    totals: totalsOf(cells),
    as_of: nowIso,
  };
}

export function getRunMatrix(runId: string, callerOrg: string | undefined): RunMatrix {
  return build(findRun(runId, callerOrg));
}

export function computeRunTotals(runId: string): RunMatrix['totals'] {
  return build(findRun(runId, undefined)).totals;
}

export interface Page<T> {
  items: T[];
  total: number;
}

export interface RunListItem {
  id: string;
  started_at: string;
  started_by: string;
  started_by_name: string;
  task_count: number;
  percent_protected: number | null;
}

export interface AllRunsItem extends RunListItem {
  campaign_id: string;
  campaign_name: string;
  campaign_deleted: boolean;
}

function runListItem(r: CampaignRunRow, snap: RunSnapshot): RunListItem {
  return {
    id: r.id,
    started_at: r.started_at,
    started_by: r.started_by,
    started_by_name: startedByName(r, snap),
    task_count: r.task_count,
    // Per-row totals are fine: the page is at most 100 rows.
    percent_protected: build(r).totals.percent_protected,
  };
}

/** Runs of one campaign, newest first, one page at a time. */
export function listRuns(campaignId: string, callerOrg: string | undefined, limit: number, offset: number): Page<RunListItem> {
  const db = getDatabase();
  const where = callerOrg !== undefined ? 'campaign_id = ? AND org_id = ?' : 'campaign_id = ?';
  const params = callerOrg !== undefined ? [campaignId, callerOrg] : [campaignId];
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM campaign_runs WHERE ${where}`).get(...params) as { c: number }).c;
  const rows = db
    .prepare(`SELECT * FROM campaign_runs WHERE ${where} ORDER BY started_at DESC, rowid DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as CampaignRunRow[];
  return { items: rows.map((r) => runListItem(r, JSON.parse(r.snapshot) as RunSnapshot)), total };
}

/** All runs of the caller's org, newest first, including runs whose campaign was deleted. */
export function listAllRuns(callerOrg: string | undefined, limit: number, offset: number): Page<AllRunsItem> {
  const db = getDatabase();
  const where = callerOrg !== undefined ? 'WHERE org_id = ?' : '';
  const params = callerOrg !== undefined ? [callerOrg] : [];
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM campaign_runs ${where}`).get(...params) as { c: number }).c;
  const rows = db
    .prepare(`SELECT * FROM campaign_runs ${where} ORDER BY started_at DESC, rowid DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as CampaignRunRow[];
  const ids = [...new Set(rows.map((r) => r.campaign_id))];
  const live = new Set(
    ids.length === 0
      ? []
      : (db.prepare(`SELECT id FROM campaigns WHERE id IN (${ids.map(() => '?').join(', ')})`).all(...ids) as { id: string }[])
          .map((c) => c.id),
  );
  const items = rows.map((r) => {
    const snap = JSON.parse(r.snapshot) as RunSnapshot;
    return {
      ...runListItem(r, snap),
      campaign_id: r.campaign_id,
      campaign_name: snap.campaign_name,
      campaign_deleted: !live.has(r.campaign_id),
    };
  });
  return { items, total };
}

/**
 * CSV header (Ruling C10). Every pair is a row: skipped pairs are `na`, and
 * `reason` says why a pair is na / not_run / error. `exit_code` is blank for
 * na and not_run (no verdict, so no exit code is evidence of anything).
 */
export const RUN_CSV_HEADER = 'test,techniques,host,os,outcome,exit_code,reason,completed_at,as_of';

export function runMatrixCsv(m: RunMatrix): string {
  const lines = [RUN_CSV_HEADER];
  for (const t of m.tests) {
    for (const a of m.agents) {
      const c = m.cells[t.uuid]?.[a.id];
      if (!c) continue;
      lines.push(
        [
          csvCell(t.name),
          csvCell(c.techniques.join('; ')),
          csvCell(a.hostname),
          csvCell(a.os),
          c.state,
          c.exit_code === null || c.state === 'na' || c.state === 'not_run' ? '' : String(c.exit_code),
          csvCell(c.reason ?? ''),
          csvCell(c.completed_at ?? ''),
          csvCell(m.as_of),
        ].join(','),
      );
    }
  }
  return lines.join('\r\n') + '\r\n';
}
