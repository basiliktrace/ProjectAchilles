import { client } from './client.js';
import type { ZtaScore, CrowdStrikeAlert } from './types.js';

export async function getZtaScore(): Promise<ZtaScore> {
  return client.get('/api/analytics/crowdstrike/zta-score');
}

export async function getZtaScoreTrend(days?: number): Promise<Array<{ timestamp: string; score: number }>> {
  return client.get('/api/analytics/crowdstrike/zta-score/trend', { params: { days } });
}

export async function getAlertsSummary(): Promise<{ total: number; byStatus: Record<string, number>; bySeverity: Record<string, number> }> {
  return client.get('/api/analytics/crowdstrike/alerts/summary');
}

export async function getAlerts(params: {
  page?: number;
  pageSize?: number;
  severity?: string;
  status?: string;
  search?: string;
  sortField?: string;
  sortOrder?: string;
} = {}): Promise<{ alerts: CrowdStrikeAlert[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } }> {
  return client.get('/api/analytics/crowdstrike/alerts', { params: params as Record<string, string | number | boolean | undefined> });
}

export async function getAlertsTrend(days?: number): Promise<Array<{ timestamp: string; count: number }>> {
  return client.get('/api/analytics/crowdstrike/alerts/trend', { params: { days } });
}

export async function getScoreCorrelation(days?: number): Promise<Array<{ timestamp: string; defenseScore: number; ztaScore: number }>> {
  return client.get('/api/analytics/crowdstrike/correlation/scores', { params: { days } });
}

export async function getTechniqueCorrelation(): Promise<{ techniques: Record<string, unknown>; coverage: unknown }> {
  return client.get('/api/analytics/crowdstrike/correlation/techniques');
}

export async function getDetectionRate(days?: number, windowMinutes?: number): Promise<Record<string, unknown>> {
  return client.get('/api/analytics/crowdstrike/correlation/detection-rate', { params: { days, windowMinutes } });
}
