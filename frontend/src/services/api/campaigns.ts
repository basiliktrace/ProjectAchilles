import { apiClient } from '@/hooks/useAuthenticatedApi';
import type { NoticeSummary } from '@/types/agent';

export type CellState =
  | 'waiting_for_notice'
  | 'running'
  | 'protected'
  | 'unprotected'
  | 'error'
  | 'not_run'
  | 'na';

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

export interface CampaignListItem extends Campaign {
  last_run: { id: string; started_at: string; percent_protected: number | null } | null;
}

export interface CampaignInput {
  name: string;
  description?: string | null;
  framework_label?: string | null;
  test_uuids: string[];
  agent_ids: string[];
}

export interface MatrixCell {
  state: CellState;
  exit_code: number | null;
  task_id: string | null;
  completed_at: string | null;
  reason: string | null;
  techniques: string[];
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

export interface PreflightResult {
  dispatch: { test_uuid: string; test_name: string; binary_name: string; agent_ids: string[] }[];
  skipped: { test_uuid: string; agent_id: string; reason: string }[];
  task_count: number;
  tests: { uuid: string; name: string }[];
  agents: { id: string; hostname: string; os: string }[];
}

export interface CampaignRunSummary {
  id: string;
  started_at: string;
  started_by: string;
  task_count: number;
  percent_protected: number | null;
}

export interface CampaignRunResult {
  run_id: string;
  [key: string]: unknown;
}

export const campaignsApi = {
  async list(): Promise<CampaignListItem[]> {
    const response = await apiClient.get('/campaigns');
    return response.data.data;
  },

  async get(id: string): Promise<Campaign> {
    const response = await apiClient.get(`/campaigns/${id}`);
    return response.data.data;
  },

  async create(input: CampaignInput & { org_id: string }): Promise<Campaign> {
    const response = await apiClient.post('/campaigns', input);
    return response.data.data;
  },

  async update(id: string, input: CampaignInput & { org_id?: string }): Promise<Campaign> {
    const response = await apiClient.put(`/campaigns/${id}`, input);
    return response.data.data;
  },

  async remove(id: string): Promise<void> {
    await apiClient.delete(`/campaigns/${id}`);
  },

  async preflight(id: string): Promise<PreflightResult> {
    const response = await apiClient.get(`/campaigns/${id}/preflight`);
    return response.data.data;
  },

  async listRuns(id: string): Promise<CampaignRunSummary[]> {
    const response = await apiClient.get(`/campaigns/${id}/runs`);
    return response.data.data;
  },

  /** A partial run rejects with a 409 whose `response.data.skipped` lists what would be skipped. */
  async startRun(id: string, body: { org_id: string; confirm_partial?: boolean }): Promise<CampaignRunResult> {
    const response = await apiClient.post(`/campaigns/${id}/runs`, body);
    return response.data.data;
  },

  async getRun(runId: string): Promise<RunMatrix> {
    const response = await apiClient.get(`/campaigns/runs/${runId}`);
    return response.data.data;
  },

  async exportRunCsv(runId: string): Promise<Blob> {
    const response = await apiClient.get(`/campaigns/runs/${runId}/export.csv`, { responseType: 'blob' });
    return response.data;
  },
};
