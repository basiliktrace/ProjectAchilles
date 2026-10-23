import { apiClient } from '@/hooks/useAuthenticatedApi';
import type { NoticeSummary } from '@/types/agent';

export type { NoticeSummary };

export interface NoticeSettings {
  enabled: boolean;
  recipients: string[];
  lead_minutes: number;
  max_wait_minutes: number;
  pickup_window_minutes: number;
  send_finished: boolean;
  last_smtp_check_at?: string;
  last_smtp_check_ok?: boolean;
  last_smtp_check_message?: string;
}

export interface NoticeSettingsResponse extends NoticeSettings {
  smtp_configured: boolean;
}

export interface NoticeTestResult {
  accepted: string[];
  rejected: string[];
  fully_accepted: boolean;
}

export interface NoticeStatus {
  pendingOverdue: number;
  notDeliveredLast7d: number;
  smtpCheck: { ok: boolean | null; at: string | null; message: string | null };
}

export const noticesApi = {
  async getSettings(): Promise<NoticeSettingsResponse> {
    const response = await apiClient.get('/notices/settings');
    return response.data.data;
  },

  /** Partial update: omitted fields keep their saved value. */
  async saveSettings(settings: Partial<NoticeSettings>): Promise<NoticeSettingsResponse> {
    const response = await apiClient.put('/notices/settings', settings);
    return response.data.data;
  },

  async sendTest(): Promise<NoticeTestResult> {
    const response = await apiClient.post('/notices/settings/test');
    return response.data.data;
  },

  async getStatus(): Promise<NoticeStatus> {
    const response = await apiClient.get('/notices/status');
    return response.data.data;
  },
};
