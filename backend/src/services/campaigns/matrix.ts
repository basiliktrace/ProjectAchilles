import { AppError } from '../../middleware/error.middleware.js';
import { getDatabase } from '../agent/database.js';
import { getNoticeSummaries } from '../notices/notices.repo.js';
import { classifyOutcome, csvCell } from '../notices/render.js';
import type { NoticeScope, NoticeSummary } from '../notices/types.js';
import type { TaskResult, TaskStatus } from '../../types/agent.js';
import type { CampaignRunRow, CellState, RunSnapshot } from './types.js';

export interface MatrixCell {
  state: CellState;
  exit_code: number | null;
  task_id: string | null;
  completed_at: string | null;
  reason: string | null;
}

export interface RunMatrix {
  run: {
    id: string;
    campaign_id: string;
    campaign_name: string;
    framework_label: string | null;
    started_by: string;
    started_at: string;
    notice: NoticeSummary | null;
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
  result: string | null;
  payload: string;
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
  const rows = getDatabase()
    .prepare(
      `SELECT id, agent_id, json_extract(payload, '$.test_uuid') AS test_uuid, status, result, payload,
              completed_at, notice_id
       FROM tasks WHERE campaign_run_id = ?
       ORDER BY created_at DESC, rowid DESC`,
    )
    .all(runId) as PairTask[];
  const out = new Map<string, PairTask>();
  for (const r of rows) {
    const key = `${r.test_uuid}\u0000${r.agent_id}`;
    if (!out.has(key)) out.set(key, r); // first seen = newest
  }
  return out;
}

function noticeReleased(n: NoticeSummary | undefined, nowIso: string): boolean {
  return !!n && (n.state === 'sent' || n.state === 'overridden') && n.release_at !== null && n.release_at <= nowIso;
}

function cellFor(task: PairTask, notices: Record<string, NoticeSummary>, nowIso: string): MatrixCell {
  const result = task.result ? (JSON.parse(task.result) as TaskResult) : null;
  const base = { exit_code: result?.exit_code ?? null, task_id: task.id, completed_at: task.completed_at, reason: null };
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
      const o = classifyOutcome({ status: task.status, result });
      state = o === 'notRun' ? 'not_run' : o;
      break;
    }
    case 'failed':
      state = 'error';
      break;
    default:
      state = 'not_run'; // expired
  }
  return { state, ...base };
}

function totalsOf(cells: Record<string, Record<string, MatrixCell>>): RunMatrix['totals'] {
  const t = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<CellState, number>;
  for (const row of Object.values(cells)) for (const c of Object.values(row)) t[c.state]++;
  const denom = t.protected + t.unprotected;
  return { ...t, percent_protected: denom === 0 ? null : Math.round((t.protected / denom) * 100) };
}

function build(row: CampaignRunRow): RunMatrix {
  const parsed = JSON.parse(row.snapshot) as Partial<RunSnapshot>;
  const snap: RunSnapshot = {
    campaign_name: parsed.campaign_name ?? '',
    framework_label: parsed.framework_label ?? null,
    tests: parsed.tests ?? [],
    agents: parsed.agents ?? [],
    skipped: parsed.skipped ?? [],
  };
  const nowIso = new Date().toISOString();
  const byPair = latestTasksByPair(row.id);
  const skipped = new Map(snap.skipped.map((s) => [`${s.test_uuid}\u0000${s.agent_id}`, s.reason]));
  const noticeIds = [...byPair.values()].map((t) => t.notice_id).filter((id): id is string => !!id);
  if (row.notice_id) noticeIds.push(row.notice_id);
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
        ? { state: 'na', exit_code: null, task_id: null, completed_at: null, reason }
        : task
          ? cellFor(task, notices, nowIso)
          : { state: 'not_run', exit_code: null, task_id: null, completed_at: null, reason: null };
    }
  }
  return {
    run: {
      id: row.id,
      campaign_id: row.campaign_id,
      campaign_name: snap.campaign_name,
      framework_label: snap.framework_label,
      started_by: row.started_by,
      started_at: row.started_at,
      notice: row.notice_id ? notices[row.notice_id] ?? null : null,
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

export function listRuns(campaignId: string, callerOrg: string | undefined) {
  const db = getDatabase();
  const rows = (callerOrg !== undefined
    ? db.prepare('SELECT * FROM campaign_runs WHERE campaign_id = ? AND org_id = ? ORDER BY started_at DESC, rowid DESC').all(campaignId, callerOrg)
    : db.prepare('SELECT * FROM campaign_runs WHERE campaign_id = ? ORDER BY started_at DESC, rowid DESC').all(campaignId)) as CampaignRunRow[];
  return rows.map((r) => ({
    id: r.id,
    started_at: r.started_at,
    started_by: r.started_by,
    task_count: r.task_count,
    percent_protected: build(r).totals.percent_protected,
  }));
}

const OUTCOME_LABEL: Partial<Record<CellState, string>> = {
  waiting_for_notice: 'waiting_for_notice',
  running: 'running',
  protected: 'protected',
  unprotected: 'unprotected',
  error: 'error',
  not_run: 'not_run',
};

export function runMatrixCsv(m: RunMatrix): string {
  const db = getDatabase();
  const techniquesFor = (taskId: string | null): string => {
    if (!taskId) return '';
    const r = db.prepare('SELECT payload FROM tasks WHERE id = ?').get(taskId) as { payload: string } | undefined;
    if (!r) return '';
    try {
      const t = (JSON.parse(r.payload) as { metadata?: { techniques?: string[] } }).metadata?.techniques;
      return Array.isArray(t) ? t.join('; ') : '';
    } catch {
      return '';
    }
  };
  const lines = ['test,techniques,host,os,outcome,exit_code,completed_at'];
  for (const t of m.tests) {
    for (const a of m.agents) {
      const c = m.cells[t.uuid]?.[a.id];
      if (!c) continue;
      lines.push(
        [
          csvCell(t.name),
          csvCell(techniquesFor(c.task_id)),
          csvCell(a.hostname),
          csvCell(a.os),
          c.state === 'na' ? '' : (OUTCOME_LABEL[c.state] ?? ''),
          c.exit_code === null ? '' : String(c.exit_code),
          csvCell(c.completed_at ?? ''),
        ].join(','),
      );
    }
  }
  return lines.join('\r\n') + '\r\n';
}
