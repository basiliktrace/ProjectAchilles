import type { EmailAlertSettings, SlackAlertSettings } from '../../types/integrations.js';

/*
 * Notice code decides whether SMTP / Slack can be used from the fields that a
 * send actually needs, not from the alerts `configured` flag. The Alerts UI
 * never sends `configured`, and saveAlertSettings keeps the old value, so the
 * flag stays false after a normal UI save (Ruling R11: the alerts code itself
 * is left alone).
 */

/** SMTP can be used for notices: a host and a from address are set. */
export function isSmtpUsable(email?: EmailAlertSettings | null): boolean {
  return !!(email?.smtp_host?.trim() && email?.from_address?.trim());
}

/** Slack can be used for notice alerts: a webhook URL is set and Slack is enabled. */
export function isSlackUsable(slack?: SlackAlertSettings | null): boolean {
  return !!(slack?.webhook_url && slack?.enabled);
}
