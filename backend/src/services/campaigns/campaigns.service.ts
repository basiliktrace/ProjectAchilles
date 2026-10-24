import { randomUUID } from 'crypto';
import { AppError } from '../../middleware/error.middleware.js';
import { getTestMetadata } from '../agent/test-catalog.service.js';
import * as repo from './campaigns.repo.js';
import { computeRunTotals } from './matrix.js';
import type { Campaign, CampaignRow } from './types.js';

export interface CampaignInput {
  name: string;
  description?: string | null;
  framework_label?: string | null;
  test_uuids: string[];
  agent_ids: string[];
}

export type CampaignListItem = Campaign & {
  last_run: { id: string; started_at: string; percent_protected: number | null } | null;
};

const MAX_TESTS = 100;
const NAME_MAX = 120;

function toCampaign(row: CampaignRow): Campaign {
  return { ...row, test_uuids: JSON.parse(row.test_uuids), agent_ids: JSON.parse(row.agent_ids) };
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

export function assertTestsKnown(testUuids: string[]): void {
  for (const uuid of testUuids) {
    if (getTestMetadata(uuid) === null) throw new AppError(`Unknown test ${uuid}`, 400);
  }
}

/**
 * Every agent must exist and (when callerOrg is set) belong to that org.
 * Unknown ids deliberately share the cross-org message so existence doesn't leak.
 */
export function assertAgentsInOrg(agentIds: string[], callerOrg: string | undefined): void {
  const found = repo.findAgentIdsInOrg(agentIds, callerOrg);
  for (const id of agentIds) {
    if (!found.has(id)) throw new AppError(`Agent ${id} does not belong to your organization`, 400);
  }
}

function validate(input: CampaignInput, agentOrg: string | undefined) {
  const name = (input.name ?? '').trim();
  if (name.length < 1 || name.length > NAME_MAX) {
    throw new AppError(`Campaign name must be 1-${NAME_MAX} characters`, 400);
  }
  const test_uuids = dedupe(input.test_uuids ?? []);
  const agent_ids = dedupe(input.agent_ids ?? []);
  if (test_uuids.length < 1) throw new AppError('A campaign needs at least 1 test', 400);
  if (test_uuids.length > MAX_TESTS) throw new AppError(`A campaign can have at most ${MAX_TESTS} tests`, 400);
  if (agent_ids.length < 1) throw new AppError('A campaign needs at least 1 agent', 400);
  assertTestsKnown(test_uuids);
  assertAgentsInOrg(agent_ids, agentOrg);
  return { name, test_uuids, agent_ids };
}

const DUP_MSG = 'A campaign with this name already exists';

export function createCampaign(input: CampaignInput, orgId: string, userId: string): Campaign {
  const v = validate(input, orgId);
  if (repo.nameExists(orgId, v.name)) throw new AppError(DUP_MSG, 409);
  const now = new Date().toISOString();
  const row: CampaignRow = {
    id: randomUUID(),
    org_id: orgId,
    name: v.name,
    description: input.description ?? null,
    framework_label: input.framework_label ?? null,
    test_uuids: JSON.stringify(v.test_uuids),
    agent_ids: JSON.stringify(v.agent_ids),
    created_by: userId,
    created_at: now,
    updated_at: now,
  };
  repo.insertCampaign(row);
  return toCampaign(row);
}

export function getCampaign(id: string, callerOrg: string | undefined): Campaign {
  const row = repo.findCampaign(id, callerOrg);
  if (!row) throw new AppError('Campaign not found', 404);
  return toCampaign(row);
}

export function updateCampaign(id: string, input: CampaignInput, callerOrg: string | undefined): Campaign {
  const existing = repo.findCampaign(id, callerOrg);
  if (!existing) throw new AppError('Campaign not found', 404);
  // Validate against the campaign's own org so a no-org caller can't attach foreign agents.
  const v = validate(input, existing.org_id);
  if (repo.nameExists(existing.org_id, v.name, id)) throw new AppError(DUP_MSG, 409);
  const next = {
    name: v.name,
    description: input.description ?? null,
    framework_label: input.framework_label ?? null,
    test_uuids: JSON.stringify(v.test_uuids),
    agent_ids: JSON.stringify(v.agent_ids),
    updated_at: new Date().toISOString(),
  };
  repo.updateCampaignRow(id, next);
  return toCampaign({ ...existing, ...next });
}

export function deleteCampaign(id: string, callerOrg: string | undefined): void {
  if (!repo.findCampaign(id, callerOrg)) throw new AppError('Campaign not found', 404);
  repo.deleteCampaignRow(id);
}

export async function listCampaigns(callerOrg: string | undefined): Promise<CampaignListItem[]> {
  const rows = repo.listCampaignRows(callerOrg);
  const runs = repo.latestRuns(rows.map((r) => r.id));
  return Promise.all(rows.map(async (row) => {
    const run = runs.get(row.id);
    return {
      ...toCampaign(row),
      last_run: run ? { id: run.id, started_at: run.started_at, percent_protected: (await computeRunTotals(run.id)).percent_protected } : null,
    };
  }));
}
