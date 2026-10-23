import { randomUUID } from 'crypto';
import { getDatabase } from '../agent/database.js';
import { createTasksBatch } from '../agent/tasks.service.js';
import { runWithNotice } from '../notices/notices.service.js';
import { AppError } from '../../middleware/error.middleware.js';
import { assertAgentsInOrg, getCampaign } from './campaigns.service.js';
import { preflightCampaign } from './preflight.js';
import type { RunSnapshot } from './types.js';

export const MAX_RUN_TASKS = 5000;

export type SkippedPair = { test_uuid: string; agent_id: string; reason: string };

/**
 * Thrown when some pairs cannot be dispatched and the caller has not confirmed.
 * The run route turns this into `{ success: false, error, skipped }` (409).
 */
export class PartialRunError extends AppError {
  skipped: SkippedPair[];

  constructor(skipped: SkippedPair[]) {
    super(`${skipped.length} test/host pair(s) cannot run; confirm to run the rest`, 409);
    this.skipped = skipped;
  }
}

export interface LaunchOptions {
  callerOrg: string | undefined;
  orgId: string;
  userId: string;
  confirmPartial: boolean;
}

/**
 * Launch a campaign run. Every task, the run row and (when enabled) the
 * pre-execution notice are written in one transaction: all or nothing.
 */
export function launchRun(
  campaignId: string,
  opts: LaunchOptions,
): { run_id: string; task_count: number; skipped: number } {
  const campaign = getCampaign(campaignId, opts.callerOrg);
  // Agents may have moved org since the campaign was saved.
  assertAgentsInOrg(campaign.agent_ids, opts.callerOrg);

  const pre = preflightCampaign(campaign);
  if (pre.task_count === 0) {
    throw new AppError('Nothing to run: every test/host pair was skipped', 400);
  }
  if (pre.task_count > MAX_RUN_TASKS) {
    throw new AppError(`Run would create ${pre.task_count} tasks (max ${MAX_RUN_TASKS})`, 400);
  }
  if (pre.skipped.length > 0 && !opts.confirmPartial) {
    throw new PartialRunError(pre.skipped);
  }

  const snapshot: RunSnapshot = {
    campaign_name: campaign.name,
    framework_label: campaign.framework_label,
    tests: pre.tests,
    agents: pre.agents,
    skipped: pre.skipped,
  };
  const requests = pre.dispatch.map((d) => ({
    agent_ids: d.agent_ids,
    test_uuid: d.test_uuid,
    test_name: d.test_name,
    binary_name: d.binary_name,
  }));
  const runId = randomUUID();
  const db = getDatabase();

  runWithNotice({ type: 'run_now', createdBy: opts.userId, orgId: opts.orgId }, (noticeId) => {
    db.prepare(
      `INSERT INTO campaign_runs (id, campaign_id, org_id, started_by, started_at, notice_id, snapshot, task_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      campaign.id,
      campaign.org_id,
      opts.userId,
      new Date().toISOString(),
      noticeId,
      JSON.stringify(snapshot),
      pre.task_count,
    );
    createTasksBatch(requests, opts.orgId, opts.userId, { noticeId, campaignRunId: runId });
  });

  return { run_id: runId, task_count: pre.task_count, skipped: pre.skipped.length };
}
