import { getDatabase } from '../agent/database.js';
import type { CampaignRow } from './types.js';

/** All campaign SQL lives here. `orgId` undefined = legacy no-org mode (no filter). */

export function insertCampaign(row: CampaignRow): void {
  getDatabase()
    .prepare(
      `INSERT INTO campaigns (id, org_id, name, description, framework_label, test_uuids, agent_ids, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id, row.org_id, row.name, row.description, row.framework_label,
      row.test_uuids, row.agent_ids, row.created_by, row.created_at, row.updated_at,
    );
}

export function findCampaign(id: string, orgId: string | undefined): CampaignRow | undefined {
  const db = getDatabase();
  return (orgId !== undefined
    ? db.prepare('SELECT * FROM campaigns WHERE id = ? AND org_id = ?').get(id, orgId)
    : db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id)) as CampaignRow | undefined;
}

export function listCampaignRows(orgId: string | undefined): CampaignRow[] {
  const db = getDatabase();
  return (orgId !== undefined
    ? db.prepare('SELECT * FROM campaigns WHERE org_id = ? ORDER BY created_at DESC, rowid DESC').all(orgId)
    : db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC, rowid DESC').all()) as CampaignRow[];
}

export function updateCampaignRow(
  id: string,
  f: Pick<CampaignRow, 'name' | 'description' | 'framework_label' | 'test_uuids' | 'agent_ids' | 'updated_at'>,
): void {
  getDatabase()
    .prepare(
      `UPDATE campaigns SET name = ?, description = ?, framework_label = ?, test_uuids = ?, agent_ids = ?, updated_at = ? WHERE id = ?`,
    )
    .run(f.name, f.description, f.framework_label, f.test_uuids, f.agent_ids, f.updated_at, id);
}

export function deleteCampaignRow(id: string): void {
  getDatabase().prepare('DELETE FROM campaigns WHERE id = ?').run(id);
}

/** Org-scoped (or unscoped) duplicate-name check, optionally excluding one id. */
export function nameExists(orgId: string, name: string, excludeId?: string): boolean {
  const row = getDatabase()
    .prepare('SELECT 1 FROM campaigns WHERE org_id = ? AND name = ? AND id != ?')
    .get(orgId, name, excludeId ?? '');
  return row !== undefined;
}

/** Ids that exist and (when orgId is given) belong to that org. */
export function findAgentIdsInOrg(agentIds: string[], orgId: string | undefined): Set<string> {
  if (agentIds.length === 0) return new Set();
  const db = getDatabase();
  const ph = agentIds.map(() => '?').join(',');
  const rows = (orgId !== undefined
    ? db.prepare(`SELECT id FROM agents WHERE id IN (${ph}) AND org_id = ?`).all(...agentIds, orgId)
    : db.prepare(`SELECT id FROM agents WHERE id IN (${ph})`).all(...agentIds)) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/** Latest run per campaign id (by started_at, then rowid). */
export function latestRuns(campaignIds: string[]): Map<string, { id: string; started_at: string }> {
  const out = new Map<string, { id: string; started_at: string }>();
  if (campaignIds.length === 0) return out;
  const ph = campaignIds.map(() => '?').join(',');
  const rows = getDatabase()
    .prepare(
      `SELECT campaign_id, id, started_at FROM campaign_runs WHERE campaign_id IN (${ph}) ORDER BY started_at ASC, rowid ASC`,
    )
    .all(...campaignIds) as { campaign_id: string; id: string; started_at: string }[];
  for (const r of rows) out.set(r.campaign_id, { id: r.id, started_at: r.started_at });
  return out;
}
