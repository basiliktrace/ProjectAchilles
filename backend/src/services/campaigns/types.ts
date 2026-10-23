/** Campaign domain types. */

export interface CampaignRow {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  framework_label: string | null;
  /** JSON-encoded string[] */
  test_uuids: string;
  /** JSON-encoded string[] */
  agent_ids: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface Campaign {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  framework_label: string | null;
  test_uuids: string[];
  agent_ids: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type CellState =
  | 'waiting_for_notice'
  | 'running'
  | 'protected'
  | 'unprotected'
  | 'error'
  | 'not_run'
  | 'na';

export interface RunSnapshot {
  campaign_name: string;
  framework_label: string | null;
  tests: { uuid: string; name: string }[];
  agents: { id: string; hostname: string; os: string }[];
  skipped: { test_uuid: string; agent_id: string; reason: string }[];
  /**
   * Display name of the user who started the run (Clerk session claims at
   * launch, else the user id). Absent on runs started before it existed.
   */
  started_by_name?: string;
}

export interface CampaignRunRow {
  id: string;
  campaign_id: string;
  org_id: string;
  started_by: string;
  started_at: string;
  notice_id: string | null;
  /** JSON-encoded RunSnapshot */
  snapshot: string;
  task_count: number;
}
