export type NoticeKind = 'run' | 'day';
export type NoticeState = 'pending' | 'sent' | 'not_delivered' | 'overridden' | 'skipped';
export type NoticeSourceType = 'run_now' | 'schedule' | 'manual_retry';

/** Mirrors the run_notices table. JSON columns are stored as TEXT. */
export interface NoticeRow {
  id: string;
  kind: NoticeKind;
  state: NoticeState;
  source_type: NoticeSourceType;
  /** JSON string[] */
  schedule_ids: string;
  schedule_id: string | null;
  window_date: string | null;
  timezone: string;
  /** JSON string[] */
  announced_agent_ids: string;
  day_window_start: string | null;
  day_window_end: string | null;
  created_by: string;
  created_at: string;
  /** JSON string[] */
  recipients: string;
  /** JSON string[] */
  accepted: string;
  /** JSON string[] */
  rejected: string;
  attempts: number;
  last_error: string | null;
  claim_at: string | null;
  sent_at: string | null;
  release_at: string | null;
  pickup_deadline: string | null;
  window_end: string | null;
  override_by: string | null;
  override_reason: string | null;
  override_at: string | null;
  skip_reason: string | null;
  finished_sent_at: string | null;
  finished_attempts: number;
  slack_failure_alerted: number;
  slack_not_delivered_alerted: number;
  /** When the latest send attempt finished (retry backoff). */
  last_attempt_at: string | null;
}

export interface NoticeSummary {
  id: string;
  run_tag: string;
  state: NoticeState;
  last_error: string | null;
  release_at: string | null;
  pickup_deadline: string | null;
}
