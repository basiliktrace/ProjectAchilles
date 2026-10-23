// Settings service for external integration credentials (Azure / Entra ID).
// Follows the same AES-256-GCM encryption pattern as analytics/settings.ts.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { encrypt as sharedEncrypt, decrypt as sharedDecrypt } from '../shared/encryption.js';
import type { AzureIntegrationSettings, AzureCredentials, DefenderIntegrationSettings, DefenderCredentials, CrowdStrikeIntegrationSettings, CrowdStrikeCredentials, AlertSettings, IntegrationsSettings, OrgIntegrationSettings, PreExecutionNoticeSettings } from '../../types/integrations.js';
import type { AutoResolveMode } from '../../types/defender.js';
import type { CrowdStrikeRegion, CrowdStrikeZtaStatus } from '../../types/crowdstrike.js';
import { CROWDSTRIKE_REGION_BASE_URLS, DEFAULT_CROWDSTRIKE_REGION } from '../crowdstrike/falcon-client.js';

const AUTO_RESOLVE_MODES: ReadonlyArray<AutoResolveMode> = ['disabled', 'dry_run', 'enabled'] as const;
const DEFAULT_AUTO_RESOLVE_MODE: AutoResolveMode = 'disabled';

const SETTINGS_DIR = path.join(os.homedir(), '.projectachilles');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'integrations.json');

const NOTICE_DEFAULTS: PreExecutionNoticeSettings = {
  enabled: false,
  recipients: [],
  lead_minutes: 5,
  max_wait_minutes: 60,
  pickup_window_minutes: 120,
  send_finished: true,
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Fill defaults and clamp numeric fields of pre-execution notice settings. */
export function clampNoticeSettings(s: Partial<PreExecutionNoticeSettings>): PreExecutionNoticeSettings {
  const out: PreExecutionNoticeSettings = {
    enabled: s.enabled ?? NOTICE_DEFAULTS.enabled,
    recipients: Array.isArray(s.recipients) ? [...s.recipients] : [],
    lead_minutes: clampInt(s.lead_minutes, 0, 5, NOTICE_DEFAULTS.lead_minutes),
    max_wait_minutes: clampInt(s.max_wait_minutes, 15, 1440, NOTICE_DEFAULTS.max_wait_minutes),
    pickup_window_minutes: clampInt(s.pickup_window_minutes, 30, 1440, NOTICE_DEFAULTS.pickup_window_minutes),
    send_finished: s.send_finished ?? NOTICE_DEFAULTS.send_finished,
  };
  if (s.last_smtp_check_at !== undefined) out.last_smtp_check_at = s.last_smtp_check_at;
  if (s.last_smtp_check_ok !== undefined) out.last_smtp_check_ok = s.last_smtp_check_ok;
  if (s.last_smtp_check_message !== undefined) out.last_smtp_check_message = s.last_smtp_check_message;
  return out;
}

export class IntegrationsSettingsService {
  /**
   * Optional Clerk org_id for per-org settings isolation (PA-018).
   * When set, reads/writes under `orgs[orgId]` with fallback to legacy top-level.
   * When unset, uses legacy top-level (backward compatible for single-org deploys).
   */
  private orgId?: string;

  constructor(orgId?: string) {
    this.orgId = orgId;
  }

  // ---------------------------------------------------------------------------
  // Encryption (delegates to shared/encryption.ts)
  // ---------------------------------------------------------------------------

  private encrypt(text: string): string { return sharedEncrypt(text); }
  private decrypt(encryptedText: string): string { return sharedDecrypt(encryptedText); }

  /**
   * Returns org-specific settings section if orgId is set, otherwise null.
   * Falls through to legacy top-level in callers.
   */
  private getOrgSection(settings: IntegrationsSettings | null): OrgIntegrationSettings | null {
    if (!this.orgId || !settings?.orgs?.[this.orgId]) return null;
    return settings.orgs[this.orgId];
  }

  private ensureSettingsDir(): void {
    if (!fs.existsSync(SETTINGS_DIR)) {
      fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Environment variable override
  // ---------------------------------------------------------------------------

  private getEnvAzureSettings(): AzureIntegrationSettings | null {
    const tenantId = process.env.AZURE_TENANT_ID;
    const clientId = process.env.AZURE_CLIENT_ID;
    if (!tenantId || !clientId) return null;

    const certThumbprint = process.env.AZURE_CERT_THUMBPRINT;
    const privateKeyPem = process.env.AZURE_PRIVATE_KEY_PEM;
    const clientSecret = process.env.AZURE_CLIENT_SECRET;

    if (certThumbprint && privateKeyPem) {
      return {
        tenant_id: tenantId,
        client_id: clientId,
        client_secret: '',
        auth_method: 'certificate',
        cert_thumbprint: certThumbprint,
        private_key_pem: privateKeyPem,
        configured: true,
        label: process.env.AZURE_TENANT_LABEL || undefined,
      };
    }

    if (!clientSecret) return null;
    return {
      tenant_id: tenantId,
      client_id: clientId,
      client_secret: clientSecret,
      auth_method: 'client_secret',
      configured: true,
      label: process.env.AZURE_TENANT_LABEL || undefined,
    };
  }

  /** Check if Azure credentials are provided via environment variables. */
  isEnvConfigured(): boolean {
    return this.getEnvAzureSettings() !== null;
  }

  // ---------------------------------------------------------------------------
  // File-based settings
  // ---------------------------------------------------------------------------

  private getFileSettings(): IntegrationsSettings | null {
    this.ensureSettingsDir();

    if (!fs.existsSync(SETTINGS_FILE)) return null;

    try {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
      const settings = JSON.parse(data) as IntegrationsSettings;

      // Decrypt sensitive Azure fields
      if (settings.azure) {
        if (settings.azure.tenant_id?.startsWith('enc:')) {
          settings.azure.tenant_id = this.decrypt(settings.azure.tenant_id.slice(4));
        }
        if (settings.azure.client_id?.startsWith('enc:')) {
          settings.azure.client_id = this.decrypt(settings.azure.client_id.slice(4));
        }
        if (settings.azure.client_secret?.startsWith('enc:')) {
          settings.azure.client_secret = this.decrypt(settings.azure.client_secret.slice(4));
        }
        if (settings.azure.cert_thumbprint?.startsWith('enc:')) {
          settings.azure.cert_thumbprint = this.decrypt(settings.azure.cert_thumbprint.slice(4));
        }
        if (settings.azure.private_key_pem?.startsWith('enc:')) {
          settings.azure.private_key_pem = this.decrypt(settings.azure.private_key_pem.slice(4));
        }
      }

      // Decrypt sensitive Defender fields
      if (settings.defender) {
        if (settings.defender.tenant_id?.startsWith('enc:')) {
          settings.defender.tenant_id = this.decrypt(settings.defender.tenant_id.slice(4));
        }
        if (settings.defender.client_id?.startsWith('enc:')) {
          settings.defender.client_id = this.decrypt(settings.defender.client_id.slice(4));
        }
        if (settings.defender.client_secret?.startsWith('enc:')) {
          settings.defender.client_secret = this.decrypt(settings.defender.client_secret.slice(4));
        }
        if (settings.defender.cert_thumbprint?.startsWith('enc:')) {
          settings.defender.cert_thumbprint = this.decrypt(settings.defender.cert_thumbprint.slice(4));
        }
        if (settings.defender.private_key_pem?.startsWith('enc:')) {
          settings.defender.private_key_pem = this.decrypt(settings.defender.private_key_pem.slice(4));
        }
      }

      // Decrypt sensitive Alert channel fields
      if (settings.alerts) {
        if (settings.alerts.slack?.webhook_url?.startsWith('enc:')) {
          settings.alerts.slack.webhook_url = this.decrypt(settings.alerts.slack.webhook_url.slice(4));
        }
        if (settings.alerts.email?.smtp_user?.startsWith('enc:')) {
          settings.alerts.email.smtp_user = this.decrypt(settings.alerts.email.smtp_user.slice(4));
        }
        if (settings.alerts.email?.smtp_pass?.startsWith('enc:')) {
          settings.alerts.email.smtp_pass = this.decrypt(settings.alerts.email.smtp_pass.slice(4));
        }
      }

      // Decrypt a single CrowdStrike section in place (top-level or per-org).
      const decryptCrowdStrike = (cs: CrowdStrikeIntegrationSettings | undefined) => {
        if (!cs) return;
        if (cs.client_id?.startsWith('enc:')) {
          cs.client_id = this.decrypt(cs.client_id.slice(4));
        }
        if (cs.client_secret?.startsWith('enc:')) {
          cs.client_secret = this.decrypt(cs.client_secret.slice(4));
        }
      };

      decryptCrowdStrike(settings.crowdstrike);
      // Per-org sections are decrypted too (the Defender/Azure org sections
      // predate this and are only decrypted at top level — decrypting here
      // keeps the CrowdStrike per-org round-trip correct).
      for (const org of Object.values(settings.orgs ?? {})) {
        decryptCrowdStrike(org.crowdstrike);
      }

      return settings;
    } catch (error) {
      console.error('Error loading integrations settings:', error);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Returns decrypted Azure settings. Org-specific > legacy file > env vars. */
  getAzureSettings(): AzureIntegrationSettings | null {
    const fileSettings = this.getFileSettings();

    // PA-018: Check org-specific settings first
    const orgSection = this.getOrgSection(fileSettings);
    if (orgSection?.azure?.configured) {
      return orgSection.azure;
    }

    // Fall back to legacy top-level
    if (fileSettings?.azure?.configured) {
      return fileSettings.azure;
    }

    return this.getEnvAzureSettings();
  }

  /** Save Azure credentials (encrypts sensitive fields). Supports partial update. */
  saveAzureSettings(settings: Partial<AzureIntegrationSettings>): void {
    this.ensureSettingsDir();

    const existing = this.getRawFileSettings() ?? {};

    // Resolve current values (from org section or legacy)
    const decrypted = this.getFileSettings() ?? {};
    const orgSection = this.getOrgSection(decrypted);
    const current = orgSection?.azure ?? decrypted.azure ?? {
      tenant_id: '',
      client_id: '',
      client_secret: '',
      configured: false,
    };

    const merged: AzureIntegrationSettings = {
      tenant_id: settings.tenant_id || current.tenant_id,
      client_id: settings.client_id || current.client_id,
      client_secret: settings.client_secret || current.client_secret,
      configured: true,
      auth_method: settings.auth_method !== undefined ? settings.auth_method : current.auth_method,
      cert_thumbprint: settings.cert_thumbprint !== undefined ? settings.cert_thumbprint : current.cert_thumbprint,
      private_key_pem: settings.private_key_pem !== undefined ? settings.private_key_pem : current.private_key_pem,
      label: settings.label !== undefined ? settings.label : current.label,
    };

    const encryptedAzure: Record<string, unknown> = {
      ...merged,
      tenant_id: 'enc:' + this.encrypt(merged.tenant_id),
      client_id: 'enc:' + this.encrypt(merged.client_id),
      client_secret: 'enc:' + this.encrypt(merged.client_secret),
    };
    if (merged.cert_thumbprint) {
      encryptedAzure.cert_thumbprint = 'enc:' + this.encrypt(merged.cert_thumbprint);
    }
    if (merged.private_key_pem) {
      encryptedAzure.private_key_pem = 'enc:' + this.encrypt(merged.private_key_pem);
    }
    const encrypted = encryptedAzure as unknown as AzureIntegrationSettings;

    // PA-018: Write to org section when orgId is set
    if (this.orgId) {
      existing.orgs ??= {};
      existing.orgs[this.orgId] ??= {};
      existing.orgs[this.orgId].azure = encrypted;
    } else {
      existing.azure = encrypted;
    }

    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(existing, null, 2), { mode: 0o600 });
  }

  /** Check if Azure integration is configured (file or env). */
  isAzureConfigured(): boolean {
    const settings = this.getAzureSettings();
    if (!settings?.configured) return false;
    if (!settings.tenant_id || !settings.client_id) return false;
    const authMethod = settings.auth_method ?? 'client_secret';
    if (authMethod === 'certificate') {
      return !!(settings.cert_thumbprint && settings.private_key_pem);
    }
    return !!settings.client_secret;
  }

  /** Returns raw decrypted credentials for injection into task payloads. */
  getAzureCredentials(): AzureCredentials | null {
    const settings = this.getAzureSettings();
    if (!settings?.configured) return null;
    if (!settings.tenant_id || !settings.client_id) return null;

    const authMethod = settings.auth_method ?? 'client_secret';
    if (authMethod === 'certificate') {
      if (!settings.cert_thumbprint || !settings.private_key_pem) return null;
      return {
        authMethod: 'certificate',
        tenant_id: settings.tenant_id,
        client_id: settings.client_id,
        cert_thumbprint: settings.cert_thumbprint,
        private_key_pem: settings.private_key_pem,
      };
    }

    if (!settings.client_secret) return null;
    return {
      authMethod: 'client_secret',
      tenant_id: settings.tenant_id,
      client_id: settings.client_id,
      client_secret: settings.client_secret,
    };
  }

  // ---------------------------------------------------------------------------
  // Microsoft Defender (Graph Security API)
  // ---------------------------------------------------------------------------

  private getEnvDefenderSettings(): DefenderIntegrationSettings | null {
    const tenantId = process.env.DEFENDER_TENANT_ID;
    const clientId = process.env.DEFENDER_CLIENT_ID;

    if (!tenantId || !clientId) return null;

    const certThumbprint = process.env.DEFENDER_CERT_THUMBPRINT;
    const privateKeyPem = process.env.DEFENDER_PRIVATE_KEY_PEM;
    const clientSecret = process.env.DEFENDER_CLIENT_SECRET;

    // Certificate auth takes precedence when both cert env vars are present
    if (certThumbprint && privateKeyPem) {
      return {
        tenant_id: tenantId,
        client_id: clientId,
        client_secret: '',
        auth_method: 'certificate',
        cert_thumbprint: certThumbprint,
        private_key_pem: privateKeyPem,
        configured: true,
        label: process.env.DEFENDER_TENANT_LABEL || undefined,
      };
    }

    if (!clientSecret) return null;

    return {
      tenant_id: tenantId,
      client_id: clientId,
      client_secret: clientSecret,
      auth_method: 'client_secret',
      configured: true,
      label: process.env.DEFENDER_TENANT_LABEL || undefined,
    };
  }

  /** Check if Defender credentials are provided via environment variables. */
  isEnvDefenderConfigured(): boolean {
    return this.getEnvDefenderSettings() !== null;
  }

  /** Returns decrypted Defender settings. Org-specific > legacy file > env vars. */
  getDefenderSettings(): DefenderIntegrationSettings | null {
    const fileSettings = this.getFileSettings();

    const orgSection = this.getOrgSection(fileSettings);
    if (orgSection?.defender?.configured) {
      return orgSection.defender;
    }

    if (fileSettings?.defender?.configured) {
      return fileSettings.defender;
    }

    return this.getEnvDefenderSettings();
  }

  /** Save Defender credentials (encrypts sensitive fields). Supports partial update. */
  saveDefenderSettings(settings: Partial<DefenderIntegrationSettings>): void {
    this.ensureSettingsDir();

    const existing = this.getRawFileSettings() ?? {};
    const decrypted = this.getFileSettings() ?? {};
    const orgSection = this.getOrgSection(decrypted);
    const current = orgSection?.defender ?? decrypted.defender ?? {
      tenant_id: '',
      client_id: '',
      client_secret: '',
      configured: false,
    };

    const merged: DefenderIntegrationSettings = {
      tenant_id: settings.tenant_id || current.tenant_id,
      client_id: settings.client_id || current.client_id,
      client_secret: settings.client_secret || current.client_secret,
      configured: true,
      auth_method: settings.auth_method !== undefined ? settings.auth_method : current.auth_method,
      cert_thumbprint: settings.cert_thumbprint !== undefined ? settings.cert_thumbprint : current.cert_thumbprint,
      private_key_pem: settings.private_key_pem !== undefined ? settings.private_key_pem : current.private_key_pem,
      label: settings.label !== undefined ? settings.label : current.label,
      last_alert_sync: settings.last_alert_sync !== undefined ? settings.last_alert_sync : current.last_alert_sync,
      last_score_sync: settings.last_score_sync !== undefined ? settings.last_score_sync : current.last_score_sync,
      auto_resolve_mode: settings.auto_resolve_mode !== undefined ? settings.auto_resolve_mode : current.auto_resolve_mode,
    };

    const encrypted: Record<string, unknown> = {
      ...merged,
      tenant_id: 'enc:' + this.encrypt(merged.tenant_id),
      client_id: 'enc:' + this.encrypt(merged.client_id),
      client_secret: 'enc:' + this.encrypt(merged.client_secret),
    };
    if (merged.cert_thumbprint) {
      encrypted.cert_thumbprint = 'enc:' + this.encrypt(merged.cert_thumbprint);
    }
    if (merged.private_key_pem) {
      encrypted.private_key_pem = 'enc:' + this.encrypt(merged.private_key_pem);
    }

    const encryptedSettings = encrypted as unknown as DefenderIntegrationSettings;

    if (this.orgId) {
      existing.orgs ??= {};
      existing.orgs[this.orgId] ??= {};
      existing.orgs[this.orgId].defender = encryptedSettings;
    } else {
      existing.defender = encryptedSettings;
    }

    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(existing, null, 2), { mode: 0o600 });
  }

  /**
   * Read persisted Defender sync timestamps from either the defender settings
   * section (file-based credentials) or the standalone defender_sync key (env var credentials).
   */
  getDefenderSyncTimestamps(): { last_alert_sync?: string; last_score_sync?: string; sync_version?: number } {
    // Check file-based defender settings first
    const settings = this.getDefenderSettings() as Record<string, any> | null;
    if (settings?.last_alert_sync || settings?.last_score_sync) {
      return {
        last_alert_sync: settings.last_alert_sync,
        last_score_sync: settings.last_score_sync,
        sync_version: settings.sync_version,
      };
    }
    // Fallback: standalone key (used when credentials come from env vars)
    const raw = this.getRawFileSettings() as Record<string, any> | null;
    const syncSection = raw?.defender_sync;
    if (syncSection) {
      return {
        last_alert_sync: syncSection.last_alert_sync,
        last_score_sync: syncSection.last_score_sync,
        sync_version: syncSection.sync_version,
      };
    }
    return {};
  }

  /**
   * Save only Defender sync timestamps without touching credentials.
   * Writes directly to the raw file to avoid the read-decrypt-merge-encrypt
   * cycle that would clobber env-var-based credentials with empty file entries.
   */
  saveDefenderSyncTimestamps(timestamps: { last_alert_sync?: string; last_score_sync?: string; sync_version?: number }): void {
    this.ensureSettingsDir();
    const existing = this.getRawFileSettings() ?? {};

    // Write timestamps into the correct section (org-specific or top-level)
    // but ONLY if that section already exists — never create a defender entry
    // just for timestamps, as that would shadow env var credentials.
    if (this.orgId && existing.orgs?.[this.orgId]?.defender) {
      const orgDefender = existing.orgs![this.orgId]!.defender!;
      if (timestamps.last_alert_sync !== undefined) orgDefender.last_alert_sync = timestamps.last_alert_sync;
      if (timestamps.last_score_sync !== undefined) orgDefender.last_score_sync = timestamps.last_score_sync;
    } else if (existing.defender) {
      if (timestamps.last_alert_sync !== undefined) existing.defender.last_alert_sync = timestamps.last_alert_sync;
      if (timestamps.last_score_sync !== undefined) existing.defender.last_score_sync = timestamps.last_score_sync;
    } else {
      // No existing defender section in file — credentials come from env vars.
      // Store timestamps in a lightweight top-level key that won't shadow env vars.
      (existing as any).defender_sync = {
        ...(existing as any).defender_sync,
        ...timestamps,
      };
    }

    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(existing, null, 2), { mode: 0o600 });
  }

  /** Check if Defender integration is configured (file or env). */
  isDefenderConfigured(): boolean {
    const settings = this.getDefenderSettings();
    if (!settings?.configured) return false;
    if (!settings.tenant_id || !settings.client_id) return false;
    const authMethod = settings.auth_method ?? 'client_secret';
    if (authMethod === 'certificate') {
      return !!(settings.cert_thumbprint && settings.private_key_pem);
    }
    return !!settings.client_secret;
  }

  /** Read raw (still-encrypted) JSON without decrypting any fields. */
  private getRawFileSettings(): IntegrationsSettings | null {
    if (!fs.existsSync(SETTINGS_FILE)) return null;
    try {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch { return null; }
  }

  /** Remove Defender integration credentials from settings file. */
  deleteDefenderSettings(): void {
    const raw = this.getRawFileSettings();
    if (!raw) return;
    if (this.orgId && raw.orgs?.[this.orgId]) {
      delete raw.orgs[this.orgId].defender;
    } else if (raw.defender) {
      delete raw.defender;
    } else {
      return;
    }
    this.ensureSettingsDir();
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(raw, null, 2), { mode: 0o600 });
  }

  /** Remove Azure integration credentials from settings file. */
  deleteAzureSettings(): void {
    const raw = this.getRawFileSettings();
    if (!raw) return;
    if (this.orgId && raw.orgs?.[this.orgId]) {
      delete raw.orgs[this.orgId].azure;
    } else if (raw.azure) {
      delete raw.azure;
    } else {
      return;
    }
    this.ensureSettingsDir();
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(raw, null, 2), { mode: 0o600 });
  }

  /** Returns decrypted Defender credentials as a discriminated union by auth method. */
  getDefenderCredentials(): DefenderCredentials | null {
    const settings = this.getDefenderSettings();
    if (!settings?.configured) return null;
    if (!settings.tenant_id || !settings.client_id) return null;

    const authMethod = settings.auth_method ?? 'client_secret';
    if (authMethod === 'certificate') {
      if (!settings.cert_thumbprint || !settings.private_key_pem) return null;
      return {
        authMethod: 'certificate',
        tenant_id: settings.tenant_id,
        client_id: settings.client_id,
        cert_thumbprint: settings.cert_thumbprint,
        private_key_pem: settings.private_key_pem,
      };
    }

    if (!settings.client_secret) return null;
    return {
      authMethod: 'client_secret',
      tenant_id: settings.tenant_id,
      client_id: settings.client_id,
      client_secret: settings.client_secret,
    };
  }

  // ---------------------------------------------------------------------------
  // Defender Auto-Resolve mode
  // ---------------------------------------------------------------------------

  /**
   * Read the current auto-resolve mode for the Defender integration.
   * Defaults to 'disabled' when the field is missing or the integration is
   * not yet configured — the auto-resolve pillar is opt-in.
   */
  getAutoResolveMode(): AutoResolveMode {
    const settings = this.getDefenderSettings();
    const mode = settings?.auto_resolve_mode;
    if (mode && AUTO_RESOLVE_MODES.includes(mode)) return mode;
    return DEFAULT_AUTO_RESOLVE_MODE;
  }

  /**
   * Persist a new auto-resolve mode without touching any other Defender
   * credentials. Throws if the mode string is not one of the valid values.
   * Does nothing (and throws) if Defender is not yet configured — we never
   * want to create a defender settings entry with empty credentials just to
   * hold a mode, since that would shadow env var credentials.
   */
  setAutoResolveMode(mode: AutoResolveMode): void {
    if (!AUTO_RESOLVE_MODES.includes(mode)) {
      throw new Error(`Invalid auto_resolve_mode: ${mode}. Must be one of: ${AUTO_RESOLVE_MODES.join(', ')}`);
    }

    const current = this.getDefenderSettings();
    if (!current?.configured) {
      throw new Error('Cannot set auto_resolve_mode: Defender integration is not configured');
    }

    // Partial update preserves credentials (encrypted) and existing sync timestamps.
    this.saveDefenderSettings({ auto_resolve_mode: mode });
  }

  // ---------------------------------------------------------------------------
  // CrowdStrike Falcon
  // ---------------------------------------------------------------------------

  /**
   * Read and validate CROWDSTRIKE_REGION from the environment. An invalid
   * value is IGNORED with a clear warning (falls back to the us-1 default) —
   * the region feeds the constant region map in falcon-client.ts, and a
   * garbage value must never influence a fetch target.
   */
  private getEnvCrowdStrikeRegion(): CrowdStrikeRegion | undefined {
    const region = process.env.CROWDSTRIKE_REGION;
    if (!region) return undefined;
    if (region in CROWDSTRIKE_REGION_BASE_URLS) return region as CrowdStrikeRegion;
    console.warn(
      `[integrations] Ignoring invalid CROWDSTRIKE_REGION='${region}' — must be one of: ${Object.keys(CROWDSTRIKE_REGION_BASE_URLS).join(', ')}. Falling back to '${DEFAULT_CROWDSTRIKE_REGION}'.`,
    );
    return undefined;
  }

  private getEnvCrowdStrikeSettings(): CrowdStrikeIntegrationSettings | null {
    const clientId = process.env.CROWDSTRIKE_CLIENT_ID;
    const clientSecret = process.env.CROWDSTRIKE_CLIENT_SECRET;

    if (!clientId || !clientSecret) return null;

    return {
      region: this.getEnvCrowdStrikeRegion(),
      client_id: clientId,
      client_secret: clientSecret,
      configured: true,
      label: process.env.CROWDSTRIKE_LABEL || undefined,
    };
  }

  /** Check if CrowdStrike credentials are provided via environment variables. */
  isEnvCrowdStrikeConfigured(): boolean {
    return this.getEnvCrowdStrikeSettings() !== null;
  }

  /** Returns decrypted CrowdStrike settings. Org-specific > legacy file > env vars. */
  getCrowdStrikeSettings(): CrowdStrikeIntegrationSettings | null {
    const fileSettings = this.getFileSettings();

    const orgSection = this.getOrgSection(fileSettings);
    if (orgSection?.crowdstrike?.configured) {
      return orgSection.crowdstrike;
    }

    if (fileSettings?.crowdstrike?.configured) {
      return fileSettings.crowdstrike;
    }

    return this.getEnvCrowdStrikeSettings();
  }

  /** Save CrowdStrike credentials (encrypts sensitive fields). Supports partial update. */
  saveCrowdStrikeSettings(settings: Partial<CrowdStrikeIntegrationSettings>): void {
    this.ensureSettingsDir();

    const existing = this.getRawFileSettings() ?? {};
    const decrypted = this.getFileSettings() ?? {};
    const orgSection = this.getOrgSection(decrypted);
    const current = orgSection?.crowdstrike ?? decrypted.crowdstrike ?? {
      client_id: '',
      client_secret: '',
      configured: false,
    };

    const merged: CrowdStrikeIntegrationSettings = {
      // Region only — the API base URL is derived from the constant region
      // map at use time, never stored.
      region: settings.region !== undefined ? settings.region : (current.region ?? DEFAULT_CROWDSTRIKE_REGION),
      client_id: settings.client_id || current.client_id,
      client_secret: settings.client_secret || current.client_secret,
      configured: true,
      label: settings.label !== undefined ? settings.label : current.label,
      last_alert_sync: settings.last_alert_sync !== undefined ? settings.last_alert_sync : current.last_alert_sync,
      last_zta_sync: settings.last_zta_sync !== undefined ? settings.last_zta_sync : current.last_zta_sync,
      zta_status: settings.zta_status !== undefined ? settings.zta_status : current.zta_status,
      auto_resolve_mode: settings.auto_resolve_mode !== undefined ? settings.auto_resolve_mode : current.auto_resolve_mode,
    };

    const encrypted = {
      ...merged,
      client_id: 'enc:' + this.encrypt(merged.client_id),
      client_secret: 'enc:' + this.encrypt(merged.client_secret),
    } as unknown as CrowdStrikeIntegrationSettings;

    if (this.orgId) {
      existing.orgs ??= {};
      existing.orgs[this.orgId] ??= {};
      existing.orgs[this.orgId].crowdstrike = encrypted;
    } else {
      existing.crowdstrike = encrypted;
    }

    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(existing, null, 2), { mode: 0o600 });
  }

  /** Check if CrowdStrike integration is configured (file or env). */
  isCrowdStrikeConfigured(): boolean {
    const settings = this.getCrowdStrikeSettings();
    if (!settings?.configured) return false;
    if (!settings.client_id) return false;
    return !!settings.client_secret;
  }

  /** Returns raw decrypted credentials for the Falcon OAuth2 client (region only — the client resolves the base URL from its constant map). */
  getCrowdStrikeCredentials(): CrowdStrikeCredentials | null {
    const settings = this.getCrowdStrikeSettings();
    if (!settings?.configured) return null;
    if (!settings.client_id || !settings.client_secret) return null;
    return {
      region: settings.region ?? DEFAULT_CROWDSTRIKE_REGION,
      client_id: settings.client_id,
      client_secret: settings.client_secret,
    };
  }

  /**
   * Masked view of the CrowdStrike settings for API responses: never exposes
   * client_secret, only whether it is set. Client IDs and labels are
   * non-secret identifiers and are shown in full. `base_url` is DERIVED from
   * the constant region map for display — never a stored string.
   */
  getCrowdStrikeSettingsMasked(): {
    configured: boolean;
    base_url?: string;
    region?: CrowdStrikeRegion;
    client_id?: string;
    label?: string;
    client_secret_set?: boolean;
    zta_status?: CrowdStrikeZtaStatus;
    auto_resolve_mode?: AutoResolveMode;
    env_configured: boolean;
  } {
    const settings = this.getCrowdStrikeSettings();
    const envConfigured = this.isEnvCrowdStrikeConfigured();

    if (!settings?.configured) {
      return { configured: false, env_configured: envConfigured };
    }

    const region = settings.region ?? DEFAULT_CROWDSTRIKE_REGION;
    return {
      configured: true,
      base_url: CROWDSTRIKE_REGION_BASE_URLS[region],
      region,
      client_id: settings.client_id,
      label: settings.label,
      client_secret_set: !!settings.client_secret,
      zta_status: settings.zta_status,
      auto_resolve_mode: settings.auto_resolve_mode,
      env_configured: envConfigured,
    };
  }

  /**
   * Remove CrowdStrike integration credentials from the settings file.
   * Refuses when credentials come from environment variables — deleting the
   * file section would leave the env vars active, so the operator must
   * remove the env vars to disconnect.
   */
  deleteCrowdStrikeSettings(): void {
    if (this.isEnvCrowdStrikeConfigured()) {
      throw new Error(
        'Cannot disconnect: CrowdStrike credentials are set via environment variables (CROWDSTRIKE_REGION, CROWDSTRIKE_CLIENT_ID, CROWDSTRIKE_CLIENT_SECRET). Remove these env vars to disconnect.',
      );
    }

    const raw = this.getRawFileSettings();
    if (!raw) return;
    if (this.orgId && raw.orgs?.[this.orgId]) {
      delete raw.orgs[this.orgId].crowdstrike;
    } else if (raw.crowdstrike) {
      delete raw.crowdstrike;
    } else {
      return;
    }
    this.ensureSettingsDir();
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(raw, null, 2), { mode: 0o600 });
  }

  /**
   * Read persisted CrowdStrike sync timestamps from either the crowdstrike
   * settings section (file-based credentials) or the standalone
   * crowdstrike_sync key (env var credentials).
   */
  getCrowdStrikeSyncTimestamps(): { last_alert_sync?: string; last_zta_sync?: string; zta_status?: CrowdStrikeZtaStatus; sync_version?: number } {
    // Check file-based crowdstrike settings first
    const settings = this.getCrowdStrikeSettings();
    if (settings?.last_alert_sync || settings?.last_zta_sync) {
      return {
        last_alert_sync: settings.last_alert_sync,
        last_zta_sync: settings.last_zta_sync,
        zta_status: settings.zta_status,
        sync_version: settings.sync_version,
      };
    }
    // Fallback: standalone key (used when credentials come from env vars)
    const raw = this.getRawFileSettings() as Record<string, any> | null;
    const syncSection = raw?.crowdstrike_sync;
    if (syncSection) {
      return {
        last_alert_sync: syncSection.last_alert_sync,
        last_zta_sync: syncSection.last_zta_sync,
        zta_status: syncSection.zta_status,
        sync_version: syncSection.sync_version,
      };
    }
    return {};
  }

  /**
   * Save only CrowdStrike sync timestamps without touching credentials.
   * Writes directly to the raw file to avoid the read-decrypt-merge-encrypt
   * cycle that would clobber env-var-based credentials with empty file entries.
   */
  saveCrowdStrikeSyncTimestamps(timestamps: { last_alert_sync?: string; last_zta_sync?: string; zta_status?: CrowdStrikeZtaStatus; sync_version?: number }): void {
    this.ensureSettingsDir();
    const existing = this.getRawFileSettings() ?? {};

    // Write timestamps into the correct section (org-specific or top-level)
    // but ONLY if that section already exists — never create a crowdstrike
    // entry just for timestamps, as that would shadow env var credentials.
    // Note: sync_version is persisted in the section too (the Defender
    // equivalent only round-trips it via the standalone defender_sync key,
    // which means file-based Defender installs never record it — we don't
    // replicate that quirk).
    if (this.orgId && existing.orgs?.[this.orgId]?.crowdstrike) {
      const orgCrowdStrike = existing.orgs![this.orgId]!.crowdstrike!;
      if (timestamps.last_alert_sync !== undefined) orgCrowdStrike.last_alert_sync = timestamps.last_alert_sync;
      if (timestamps.last_zta_sync !== undefined) orgCrowdStrike.last_zta_sync = timestamps.last_zta_sync;
      if (timestamps.zta_status !== undefined) orgCrowdStrike.zta_status = timestamps.zta_status;
      if (timestamps.sync_version !== undefined) orgCrowdStrike.sync_version = timestamps.sync_version;
    } else if (existing.crowdstrike) {
      if (timestamps.last_alert_sync !== undefined) existing.crowdstrike.last_alert_sync = timestamps.last_alert_sync;
      if (timestamps.last_zta_sync !== undefined) existing.crowdstrike.last_zta_sync = timestamps.last_zta_sync;
      if (timestamps.zta_status !== undefined) existing.crowdstrike.zta_status = timestamps.zta_status;
      if (timestamps.sync_version !== undefined) existing.crowdstrike.sync_version = timestamps.sync_version;
    } else {
      // No existing crowdstrike section in file — credentials come from env vars.
      // Store timestamps in a lightweight top-level key that won't shadow env vars.
      (existing as any).crowdstrike_sync = {
        ...(existing as any).crowdstrike_sync,
        ...timestamps,
      };
    }

    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(existing, null, 2), { mode: 0o600 });
  }

  // ---------------------------------------------------------------------------
  // CrowdStrike Auto-Resolve mode
  // ---------------------------------------------------------------------------

  /**
   * Read the current auto-resolve mode for the CrowdStrike integration.
   * Defaults to 'disabled' when the field is missing or the integration is
   * not yet configured — the auto-resolve pillar is opt-in.
   */
  getCrowdStrikeAutoResolveMode(): AutoResolveMode {
    const settings = this.getCrowdStrikeSettings();
    const mode = settings?.auto_resolve_mode;
    if (mode && AUTO_RESOLVE_MODES.includes(mode)) return mode;
    return DEFAULT_AUTO_RESOLVE_MODE;
  }

  /**
   * Persist a new auto-resolve mode without touching any other CrowdStrike
   * credentials. Throws if the mode string is not one of the valid values.
   * Does nothing (and throws) if CrowdStrike is not yet configured — we never
   * want to create a crowdstrike settings entry with empty credentials just to
   * hold a mode, since that would shadow env var credentials.
   */
  setCrowdStrikeAutoResolveMode(mode: AutoResolveMode): void {
    if (!AUTO_RESOLVE_MODES.includes(mode)) {
      throw new Error(`Invalid auto_resolve_mode: ${mode}. Must be one of: ${AUTO_RESOLVE_MODES.join(', ')}`);
    }

    const current = this.getCrowdStrikeSettings();
    if (!current?.configured) {
      throw new Error('Cannot set auto_resolve_mode: CrowdStrike integration is not configured');
    }

    // Partial update preserves credentials (encrypted) and existing sync timestamps.
    this.saveCrowdStrikeSettings({ auto_resolve_mode: mode });
  }

  // ---------------------------------------------------------------------------
  // Trend Alerting
  // ---------------------------------------------------------------------------

  /** Returns decrypted alert settings. Org-specific > legacy. */
  getAlertSettings(): AlertSettings | null {
    const fileSettings = this.getFileSettings();

    const orgSection = this.getOrgSection(fileSettings);
    if (orgSection?.alerts) return orgSection.alerts;

    if (!fileSettings?.alerts) return null;
    return fileSettings.alerts;
  }

  /** Save alert settings (encrypts sensitive channel fields). Supports partial update. */
  saveAlertSettings(settings: Partial<AlertSettings>): void {
    this.ensureSettingsDir();

    // Load existing to support partial update
    const decrypted = this.getFileSettings() ?? {};
    const orgSection = this.getOrgSection(decrypted);
    const current: AlertSettings = orgSection?.alerts ?? decrypted.alerts ?? {
      thresholds: { enabled: false },
      cooldown_minutes: 15,
    };

    // Deep merge
    const merged: AlertSettings = {
      thresholds: settings.thresholds
        ? { ...current.thresholds, ...settings.thresholds }
        : current.thresholds,
      cooldown_minutes: settings.cooldown_minutes ?? current.cooldown_minutes,
      last_alert_at: settings.last_alert_at !== undefined
        ? settings.last_alert_at
        : current.last_alert_at,
    };

    // Merge Slack channel
    if (settings.slack || current.slack) {
      const currentSlack = current.slack;
      const newSlack = settings.slack;
      merged.slack = {
        webhook_url: newSlack?.webhook_url || currentSlack?.webhook_url || '',
        configured: newSlack?.configured ?? currentSlack?.configured ?? false,
        enabled: newSlack?.enabled ?? currentSlack?.enabled ?? false,
      };
    }

    // Merge Email channel
    if (settings.email || current.email) {
      const currentEmail = current.email;
      const newEmail = settings.email;
      merged.email = {
        smtp_host: newEmail?.smtp_host || currentEmail?.smtp_host || '',
        smtp_port: newEmail?.smtp_port ?? currentEmail?.smtp_port ?? 587,
        smtp_secure: newEmail?.smtp_secure ?? currentEmail?.smtp_secure ?? false,
        smtp_user: newEmail?.smtp_user || currentEmail?.smtp_user || '',
        smtp_pass: newEmail?.smtp_pass || currentEmail?.smtp_pass || '',
        from_address: newEmail?.from_address || currentEmail?.from_address || '',
        recipients: newEmail?.recipients ?? currentEmail?.recipients ?? [],
        configured: newEmail?.configured ?? currentEmail?.configured ?? false,
        enabled: newEmail?.enabled ?? currentEmail?.enabled ?? false,
      };
    }

    // Merge Agent Alerts
    if (settings.agent_alerts || current.agent_alerts) {
      const currentAgent = current.agent_alerts;
      const newAgent = settings.agent_alerts;
      merged.agent_alerts = {
        enabled: newAgent?.enabled ?? currentAgent?.enabled ?? false,
        offline_hours_threshold: newAgent?.offline_hours_threshold ?? currentAgent?.offline_hours_threshold,
        flapping_threshold: newAgent?.flapping_threshold ?? currentAgent?.flapping_threshold,
        fleet_online_percent_min: newAgent?.fleet_online_percent_min ?? currentAgent?.fleet_online_percent_min,
        cooldown_minutes: newAgent?.cooldown_minutes ?? currentAgent?.cooldown_minutes,
        last_alert_at: newAgent?.last_alert_at !== undefined ? newAgent.last_alert_at : currentAgent?.last_alert_at,
      };
    }

    // Encrypt sensitive channel fields
    const alertsToSave: AlertSettings = { ...merged };

    if (alertsToSave.slack) {
      alertsToSave.slack = {
        ...alertsToSave.slack,
        webhook_url: alertsToSave.slack.webhook_url
          ? 'enc:' + this.encrypt(alertsToSave.slack.webhook_url)
          : '',
      };
    }

    if (alertsToSave.email) {
      alertsToSave.email = {
        ...alertsToSave.email,
        smtp_user: alertsToSave.email.smtp_user
          ? 'enc:' + this.encrypt(alertsToSave.email.smtp_user)
          : '',
        smtp_pass: alertsToSave.email.smtp_pass
          ? 'enc:' + this.encrypt(alertsToSave.email.smtp_pass)
          : '',
      };
    }

    // PA-018: Write to org section when orgId is set
    const raw = this.getRawFileSettings() ?? {};
    if (this.orgId) {
      raw.orgs ??= {};
      raw.orgs[this.orgId] ??= {};
      raw.orgs[this.orgId].alerts = alertsToSave;
    } else {
      raw.alerts = alertsToSave;
    }

    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(raw, null, 2), { mode: 0o600 });
  }

  // ---------------------------------------------------------------------------
  // Pre-execution notices (deployment-wide: always the legacy top level)
  // ---------------------------------------------------------------------------

  /** Always returns a full settings object (defaults filled, numbers clamped). */
  getPreExecutionNoticeSettings(): PreExecutionNoticeSettings {
    return clampNoticeSettings(this.getFileSettings()?.pre_execution_notices ?? {});
  }

  /** Merge a patch into the stored settings, clamp, and persist at the top level regardless of orgId. */
  savePreExecutionNoticeSettings(patch: Partial<PreExecutionNoticeSettings>): PreExecutionNoticeSettings {
    this.ensureSettingsDir();
    const merged = clampNoticeSettings({ ...this.getPreExecutionNoticeSettings(), ...patch });
    const raw = this.getRawFileSettings() ?? {};
    raw.pre_execution_notices = merged;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(raw, null, 2), { mode: 0o600 });
    return merged;
  }

  /** Check if alerting is configured: thresholds enabled + at least one channel configured & enabled. */
  isAlertingConfigured(): boolean {
    const settings = this.getAlertSettings();
    if (!settings?.thresholds?.enabled) return false;

    const slackReady = !!(settings.slack?.configured && settings.slack?.enabled);
    const emailReady = !!(settings.email?.configured && settings.email?.enabled);

    return slackReady || emailReady;
  }

  /** Convenience: update the last_alert_at timestamp. */
  updateLastAlertTimestamp(timestamp: string): void {
    this.saveAlertSettings({ last_alert_at: timestamp });
  }
}
