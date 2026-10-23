import { getDatabase } from '../agent/database.js';
import { getTestMetadata } from '../agent/test-catalog.service.js';
import { resolveTestArtifact } from '../agent/testArtifacts.js';
import type { Campaign } from './types.js';

export interface PreflightResult {
  /** One entry per test: the agents that will actually receive a task. */
  dispatch: { test_uuid: string; test_name: string; binary_name: string; agent_ids: string[] }[];
  skipped: { test_uuid: string; agent_id: string; reason: string }[];
  /** Number of dispatchable (test, agent) pairs. */
  task_count: number;
  tests: { uuid: string; name: string }[];
  agents: { id: string; hostname: string; os: string }[];
}

interface AgentRow {
  id: string;
  hostname: string;
  os: string;
  status: string;
  org_id: string;
}

/**
 * Dry-run a campaign: decide, per (test, agent) pair, whether a task can be
 * created. Uses the same artifact resolution as createTasks so the two cannot
 * disagree. Pure read; writes nothing.
 */
function checkArtifact(testUuid: string, os: string) {
  return resolveTestArtifact(testUuid, os, { hash: false });
}

export function preflightCampaign(campaign: Campaign): PreflightResult {
  const db = getDatabase();
  const ids = campaign.agent_ids;
  const rows = ids.length
    ? (db
        .prepare(`SELECT id, hostname, os, status, org_id FROM agents WHERE id IN (${ids.map(() => '?').join(', ')})`)
        .all(...ids) as AgentRow[])
    : [];
  // Agents from another org are treated as ineligible and never exposed.
  const foreign = new Set(rows.filter((r) => r.org_id !== campaign.org_id).map((r) => r.id));
  const byId = new Map(rows.filter((r) => !foreign.has(r.id)).map((r) => [r.id, r]));

  const result: PreflightResult = { dispatch: [], skipped: [], task_count: 0, tests: [], agents: [] };

  for (const id of ids) {
    const a = byId.get(id);
    if (a) result.agents.push({ id: a.id, hostname: a.hostname, os: a.os });
  }

  for (const testUuid of campaign.test_uuids) {
    const meta = getTestMetadata(testUuid);
    if (!meta) {
      result.tests.push({ uuid: testUuid, name: testUuid });
      for (const agentId of ids) {
        result.skipped.push({ test_uuid: testUuid, agent_id: agentId, reason: 'removed from library' });
      }
      continue;
    }
    result.tests.push({ uuid: testUuid, name: meta.name });

    const agentIds: string[] = [];
    let binaryName = '';
    // At most one resolution per (test, os): existence only, no hashing.
    const byOs = new Map<string, ReturnType<typeof checkArtifact>>();
    for (const agentId of ids) {
      const agent = byId.get(agentId);
      if (foreign.has(agentId)) {
        result.skipped.push({ test_uuid: testUuid, agent_id: agentId, reason: 'agent not in organization' });
        continue;
      }
      if (!agent) {
        result.skipped.push({ test_uuid: testUuid, agent_id: agentId, reason: 'agent deleted' });
        continue;
      }
      if (agent.status !== 'active') {
        result.skipped.push({ test_uuid: testUuid, agent_id: agentId, reason: `agent ${agent.status}` });
        continue;
      }
      let res = byOs.get(agent.os);
      if (!res) {
        res = checkArtifact(testUuid, agent.os);
        byOs.set(agent.os, res);
      }
      if (!res.ok) {
        result.skipped.push({ test_uuid: testUuid, agent_id: agentId, reason: res.reason });
        continue;
      }
      agentIds.push(agentId);
      // binary_name is a required request field; the per-OS name actually used
      // is re-resolved per agent inside createTasks.
      binaryName = binaryName || res.binaryName;
    }
    if (agentIds.length > 0) {
      result.dispatch.push({ test_uuid: testUuid, test_name: meta.name, binary_name: binaryName, agent_ids: agentIds });
      result.task_count += agentIds.length;
    }
  }
  return result;
}
