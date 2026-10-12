/**
 * Zod schemas for integration endpoints (Azure, Defender, Alerts).
 */

import { z } from 'zod';

// ── Azure / Entra ID ─────────────────────────────────────────────────────────

export const AzureCredentialsSchema = z.object({
  tenant_id: z.string().optional(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  label: z.string().optional(),
  auth_method: z.enum(['client_secret', 'certificate']).optional(),
  cert_thumbprint: z.string().optional(),
  private_key_pem: z.string().optional(),
});

export const AzureTestSchema = z.object({
  tenant_id: z.string().optional(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  auth_method: z.enum(['client_secret', 'certificate']).optional(),
  cert_thumbprint: z.string().optional(),
  private_key_pem: z.string().optional(),
});

// ── Defender ─────────────────────────────────────────────────────────────────

export const DefenderCredentialsSchema = z.object({
  tenant_id: z.string().optional(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  label: z.string().optional(),
  auth_method: z.enum(['client_secret', 'certificate']).optional(),
  cert_thumbprint: z.string().optional(),
  private_key_pem: z.string().optional(),
});

export const DefenderTestSchema = z.object({
  tenant_id: z.string().optional(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  auth_method: z.enum(['client_secret', 'certificate']).optional(),
  cert_thumbprint: z.string().optional(),
  private_key_pem: z.string().optional(),
});

export const DefenderAutoResolveModeSchema = z.object({
  mode: z.enum(['disabled', 'dry_run', 'enabled']),
});

// ── CrowdStrike Falcon ───────────────────────────────────────────────────────

const CrowdStrikeRegionSchema = z.enum(['us-1', 'us-2', 'eu-1', 'us-gov-1']);

export const CrowdStrikeCredentialsSchema = z.object({
  base_url: z.string().url().optional(),
  region: CrowdStrikeRegionSchema.optional(),
  // Falcon client IDs are 32-char lowercase hex
  client_id: z.string().regex(/^[0-9a-f]{32}$/, 'client_id must be a 32-character lowercase hex string').optional(),
  client_secret: z.string().min(1).optional(),
  label: z.string().optional(),
});

export const CrowdStrikeTestSchema = z.object({
  base_url: z.string().url().optional(),
  region: CrowdStrikeRegionSchema.optional(),
  client_id: z.string().regex(/^[0-9a-f]{32}$/, 'client_id must be a 32-character lowercase hex string').optional(),
  client_secret: z.string().optional(),
});

export const CrowdStrikeAutoResolveModeSchema = z.object({
  mode: z.enum(['disabled', 'dry_run', 'enabled']),
});

// ── Alert Settings ───────────────────────────────────────────────────────────

const AlertThresholdsSchema = z.object({
  enabled: z.boolean().optional(),
  score_drop_percent: z.number().min(0).max(100).optional(),
  score_floor: z.number().min(0).max(100).optional(),
}).optional();

const SlackChannelSchema = z.object({
  webhook_url: z.string().optional(),
  configured: z.boolean().optional(),
  enabled: z.boolean().optional(),
}).optional();

const EmailChannelSchema = z.object({
  smtp_host: z.string().optional(),
  smtp_port: z.number().int().min(1).max(65535).optional(),
  smtp_secure: z.boolean().optional(),
  smtp_user: z.string().optional(),
  smtp_pass: z.string().optional(),
  from_address: z.string().optional(),
  recipients: z.array(z.string()).optional(),
  configured: z.boolean().optional(),
  enabled: z.boolean().optional(),
}).optional();

const AgentAlertsSchema = z.object({
  enabled: z.boolean().optional(),
  offline_hours_threshold: z.number().optional(),
  flapping_threshold: z.number().int().optional(),
  fleet_online_percent_min: z.number().min(0).max(100).optional(),
  cooldown_minutes: z.number().int().optional(),
  last_alert_at: z.string().nullable().optional(),
}).optional();

export const AlertSettingsSchema = z.object({
  thresholds: AlertThresholdsSchema,
  cooldown_minutes: z.number().int().min(1).optional(),
  last_alert_at: z.string().nullable().optional(),
  slack: SlackChannelSchema,
  email: EmailChannelSchema,
  agent_alerts: AgentAlertsSchema,
});

export const AlertTestSchema = z.object({
  slack_webhook_url: z.string().optional(),
  email: EmailChannelSchema,
});
