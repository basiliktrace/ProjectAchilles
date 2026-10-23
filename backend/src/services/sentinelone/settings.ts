// Settings for the SentinelOne integration.
// Stored in the same ~/.projectachilles/integrations.json file as the other
// integrations (key `sentinelone`, or `orgs[orgId].sentinelone` for per-org
// isolation — PA-018), with the API token AES-256-GCM encrypted via
// shared/encryption.ts. Other sections of the file are preserved untouched:
// every write is a read-raw → mutate-own-key → write cycle.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { encrypt, decrypt } from '../shared/encryption.js';
import { normalizeSentinelOneBaseUrl } from './s1-client.js';
import type {
  SentinelOneIntegrationSettings,
  SentinelOneCredentials,
  SentinelOnePermissionMode,
  SentinelOneSettingsMasked,
  SentinelOneSource,
  SentinelOneAutoMitigationAction,
  SentinelOneAutoMitigationSettings,
  AutoResolveMode,
} from '../../types/sentinelone.js';

export const S1_DEFAULT_POLL_INTERVAL_MINUTES = 5;
export const S1_DEFAULT_BACKFILL_DAYS = 365; // console alert retention is 1 year
export const S1_MAX_BACKFILL_DAYS = 365;
export const S1_DEFAULT_SOURCES: SentinelOneSource[] = ['threats', 'cloud_detection_alerts'];

export const S1_AUTO_RESOLVE_MODES: ReadonlyArray<AutoResolveMode> = ['disabled', 'dry_run', 'enabled'] as const;
/** Same default as Defender: nothing is written to the console until the user opts in. */
export const S1_DEFAULT_AUTO_RESOLVE_MODE: AutoResolveMode = 'disabled';
export const S1_AUTO_MITIGATION_ACTIONS: ReadonlyArray<SentinelOneAutoMitigationAction> = ['kill', 'quarantine'] as const;
export const S1_DEFAULT_AUTO_MITIGATION: SentinelOneAutoMitigationSettings = { mode: 'disabled', action: 'kill' };

/** Normalize a stored auto-mitigation block; unknown values fail closed to the default. */
function normalizeAutoMitigation(v: unknown): SentinelOneAutoMitigationSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<SentinelOneAutoMitigationSettings>;
  return {
    mode: S1_AUTO_RESOLVE_MODES.includes(o.mode as AutoResolveMode) ? (o.mode as AutoResolveMode) : 'disabled',
    action: S1_AUTO_MITIGATION_ACTIONS.includes(o.action as SentinelOneAutoMitigationAction)
      ? (o.action as SentinelOneAutoMitigationAction)
      : S1_DEFAULT_AUTO_MITIGATION.action,
  };
}

const SETTINGS_DIR = path.join(os.homedir(), '.projectachilles');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'integrations.json');

type RawFile = Record<string, any> & { orgs?: Record<string, Record<string, any>> };

export interface SentinelOneSyncCheckpoints {
  last_threat_sync?: string;
  last_alert_sync?: string;
  sync_version?: number;
  last_posture_sync?: string;
}

export class SentinelOneSettingsService {
  constructor(private orgId?: string) {}

  private ensureSettingsDir(): void {
    if (!fs.existsSync(SETTINGS_DIR)) fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  }

  private readRaw(): RawFile {
    if (!fs.existsSync(SETTINGS_FILE)) return {};
    try {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as RawFile;
    } catch {
      return {};
    }
  }

  private writeRaw(raw: RawFile): void {
    this.ensureSettingsDir();
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(raw, null, 2), { mode: 0o600 });
  }

  private decryptSection(section: SentinelOneIntegrationSettings | undefined): SentinelOneIntegrationSettings | null {
    if (!section) return null;
    const copy = { ...section };
    if (copy.api_token?.startsWith('enc:')) copy.api_token = decrypt(copy.api_token.slice(4));
    return copy;
  }

  // ---------------------------------------------------------------------------
  // Env override (SENTINELONE_BASE_URL + SENTINELONE_API_TOKEN)
  // ---------------------------------------------------------------------------

  private getEnvSettings(): SentinelOneIntegrationSettings | null {
    const baseUrl = process.env.SENTINELONE_BASE_URL;
    const token = process.env.SENTINELONE_API_TOKEN;
    if (!baseUrl || !token) return null;
    let normalized: string;
    try {
      normalized = normalizeSentinelOneBaseUrl(baseUrl);
    } catch (err) {
      console.warn(`[integrations] Ignoring invalid SENTINELONE_BASE_URL: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    return {
      base_url: normalized,
      api_token: token,
      configured: true,
      label: process.env.SENTINELONE_LABEL || undefined,
      permission_mode: process.env.SENTINELONE_PERMISSION_MODE === 'response' ? 'response' : 'read_only',
    };
  }

  isEnvConfigured(): boolean {
    return this.getEnvSettings() !== null;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Decrypted settings. Org-specific > legacy file > env vars. */
  getSettings(): SentinelOneIntegrationSettings | null {
    const raw = this.readRaw();
    if (this.orgId) {
      const org = this.decryptSection(raw.orgs?.[this.orgId]?.sentinelone);
      if (org?.configured) return org;
    }
    const top = this.decryptSection(raw.sentinelone);
    if (top?.configured) return top;
    const env = this.getEnvSettings();
    // Env-var credentials keep their non-secret toggles in the state key.
    if (env && raw.sentinelone_sync) {
      const { auto_resolve_mode, auto_mitigation } = raw.sentinelone_sync;
      return { ...env, auto_resolve_mode, auto_mitigation };
    }
    return env;
  }

  isConfigured(): boolean {
    const s = this.getSettings();
    return !!(s?.configured && s.base_url && s.api_token);
  }

  getPermissionMode(): SentinelOnePermissionMode {
    return this.getSettings()?.permission_mode === 'response' ? 'response' : 'read_only';
  }

  getCredentials(): SentinelOneCredentials | null {
    const s = this.getSettings();
    if (!s?.configured || !s.base_url || !s.api_token) return null;
    return { base_url: s.base_url, api_token: s.api_token, permission_mode: s.permission_mode === 'response' ? 'response' : 'read_only' };
  }

  /** Save (partial update). The token is only replaced when a new one is given. */
  saveSettings(update: Partial<SentinelOneIntegrationSettings>): void {
    const raw = this.readRaw();
    const currentEncrypted: SentinelOneIntegrationSettings | undefined = this.orgId
      ? raw.orgs?.[this.orgId]?.sentinelone
      : raw.sentinelone;
    const current = this.decryptSection(currentEncrypted);

    const baseUrl = update.base_url ? normalizeSentinelOneBaseUrl(update.base_url) : current?.base_url;
    const token = update.api_token || current?.api_token;
    if (!baseUrl || !token) throw new Error('base_url and api_token are required for initial setup');

    // A changed console or scope invalidates the incremental checkpoints.
    const scopeChanged = (update.base_url && baseUrl !== current?.base_url)
      || (update.scope !== undefined && JSON.stringify(update.scope) !== JSON.stringify(current?.scope));

    const permissionMode = update.permission_mode ?? current?.permission_mode ?? 'read_only';
    // Automatic mitigation only exists in Response mode: downgrading the
    // integration to read-only switches it off (fail closed).
    const currentMitigation = normalizeAutoMitigation(current?.auto_mitigation);
    const autoMitigation = permissionMode === 'response' ? currentMitigation : { ...currentMitigation, mode: 'disabled' as const };

    const merged: SentinelOneIntegrationSettings = {
      base_url: baseUrl,
      api_token: 'enc:' + encrypt(token),
      configured: true,
      label: update.label !== undefined ? update.label : current?.label,
      permission_mode: permissionMode,
      poll_interval_minutes: update.poll_interval_minutes ?? current?.poll_interval_minutes ?? S1_DEFAULT_POLL_INTERVAL_MINUTES,
      backfill_days: update.backfill_days ?? current?.backfill_days ?? S1_DEFAULT_BACKFILL_DAYS,
      sources: update.sources ?? current?.sources ?? S1_DEFAULT_SOURCES,
      scope: update.scope ?? current?.scope ?? {},
      filters: update.filters ?? current?.filters ?? {},
      last_threat_sync: scopeChanged ? undefined : current?.last_threat_sync,
      last_alert_sync: scopeChanged ? undefined : current?.last_alert_sync,
      sync_version: scopeChanged ? undefined : current?.sync_version,
      auto_resolve_mode: current?.auto_resolve_mode ?? S1_DEFAULT_AUTO_RESOLVE_MODE,
      auto_mitigation: autoMitigation,
      last_posture_sync: scopeChanged ? undefined : current?.last_posture_sync,
    };

    if (this.orgId) {
      raw.orgs ??= {};
      raw.orgs[this.orgId] ??= {};
      raw.orgs[this.orgId].sentinelone = merged;
    } else {
      raw.sentinelone = merged;
    }
    this.writeRaw(raw);
  }

  /** Remove stored settings (refuses when credentials come from env vars). */
  deleteSettings(): void {
    if (this.isEnvConfigured()) {
      throw new Error('Cannot disconnect: SentinelOne credentials are set via environment variables (SENTINELONE_BASE_URL, SENTINELONE_API_TOKEN). Remove these env vars to disconnect.');
    }
    const raw = this.readRaw();
    if (this.orgId && raw.orgs?.[this.orgId]?.sentinelone) delete raw.orgs[this.orgId].sentinelone;
    else if (raw.sentinelone) delete raw.sentinelone;
    else return;
    delete raw.sentinelone_sync;
    this.writeRaw(raw);
  }

  /** Masked view for API responses — the token is never returned. */
  getMasked(): SentinelOneSettingsMasked {
    const s = this.getSettings();
    const envConfigured = this.isEnvConfigured();
    if (!s?.configured) return { configured: false, env_configured: envConfigured };
    return {
      configured: true,
      env_configured: envConfigured,
      base_url: s.base_url,
      label: s.label,
      api_token_set: !!s.api_token,
      permission_mode: s.permission_mode === 'response' ? 'response' : 'read_only',
      poll_interval_minutes: s.poll_interval_minutes ?? S1_DEFAULT_POLL_INTERVAL_MINUTES,
      backfill_days: s.backfill_days ?? S1_DEFAULT_BACKFILL_DAYS,
      sources: s.sources ?? S1_DEFAULT_SOURCES,
      scope: s.scope ?? {},
      filters: s.filters ?? {},
      auto_resolve_mode: this.getAutoResolveMode(),
      auto_mitigation: this.getAutoMitigation(),
    };
  }

  // ---------------------------------------------------------------------------
  // Auto-resolve / automatic mitigation (server-side guarded)
  // ---------------------------------------------------------------------------

  /** Current auto-resolve mode; unknown / missing values fail closed to 'disabled'. */
  getAutoResolveMode(): AutoResolveMode {
    const mode = this.getSettings()?.auto_resolve_mode;
    return S1_AUTO_RESOLVE_MODES.includes(mode as AutoResolveMode) ? (mode as AutoResolveMode) : S1_DEFAULT_AUTO_RESOLVE_MODE;
  }

  /**
   * Set the auto-resolve mode. 'enabled' writes incident status + notes to
   * the console, so it requires Response mode (the client refuses writes in
   * read-only mode anyway). 'dry_run' never writes and is allowed in both.
   */
  setAutoResolveMode(mode: AutoResolveMode): void {
    if (!S1_AUTO_RESOLVE_MODES.includes(mode)) {
      throw new Error(`Invalid auto_resolve_mode: ${mode}. Must be one of: ${S1_AUTO_RESOLVE_MODES.join(', ')}`);
    }
    if (!this.getSettings()?.configured) throw new Error('Cannot set auto_resolve_mode: SentinelOne integration is not configured');
    if (mode === 'enabled' && this.getPermissionMode() !== 'response') {
      throw new Error('Auto-resolve "enabled" writes incident status to SentinelOne and requires the integration to be in Response mode. Use dry_run in read-only mode.');
    }
    this.patchOwnSection({ auto_resolve_mode: mode });
  }

  /** Automatic mitigation settings; anything other than Response mode reads as disabled. */
  getAutoMitigation(): SentinelOneAutoMitigationSettings {
    const s = this.getSettings();
    const cfg = normalizeAutoMitigation(s?.auto_mitigation);
    if (s?.permission_mode !== 'response') return { ...cfg, mode: 'disabled' };
    return cfg;
  }

  /**
   * Opt in/out of automatic mitigation. Any mode other than 'disabled' is
   * refused unless the integration is in Response mode — enforced here,
   * server-side, not only in the UI.
   */
  setAutoMitigation(update: Partial<SentinelOneAutoMitigationSettings>): SentinelOneAutoMitigationSettings {
    const s = this.getSettings();
    if (!s?.configured) throw new Error('Cannot configure automatic mitigation: SentinelOne integration is not configured');
    if (update.mode !== undefined && !S1_AUTO_RESOLVE_MODES.includes(update.mode)) {
      throw new Error(`Invalid automatic mitigation mode: ${update.mode}`);
    }
    if (update.action !== undefined && !S1_AUTO_MITIGATION_ACTIONS.includes(update.action)) {
      throw new Error(`Invalid automatic mitigation action: ${update.action}. Allowed: ${S1_AUTO_MITIGATION_ACTIONS.join(', ')}`);
    }
    const next = { ...normalizeAutoMitigation(s.auto_mitigation), ...update };
    if (next.mode !== 'disabled' && s.permission_mode !== 'response') {
      throw new Error('Automatic mitigation can only be turned on when the SentinelOne integration is in Response mode.');
    }
    this.patchOwnSection({ auto_mitigation: next });
    return next;
  }

  /** Write non-credential keys into the stored section (file-backed settings only). */
  private patchOwnSection(patch: Partial<SentinelOneIntegrationSettings>): void {
    const raw = this.readRaw();
    const section: Record<string, any> | undefined = (this.orgId ? raw.orgs?.[this.orgId]?.sentinelone : undefined) ?? raw.sentinelone;
    if (!section) {
      // Env-var credentials: keep the toggle in the standalone state key.
      Object.assign((raw.sentinelone_sync ??= {}), patch);
    } else {
      Object.assign(section, patch);
    }
    this.writeRaw(raw);
  }

  // ---------------------------------------------------------------------------
  // Sync checkpoints (never touch credentials)
  // ---------------------------------------------------------------------------

  getCheckpoints(): SentinelOneSyncCheckpoints {
    const raw = this.readRaw();
    const section = (this.orgId ? raw.orgs?.[this.orgId]?.sentinelone : undefined) ?? raw.sentinelone ?? raw.sentinelone_sync;
    if (!section) return {};
    return {
      last_threat_sync: section.last_threat_sync,
      last_alert_sync: section.last_alert_sync,
      sync_version: section.sync_version,
      last_posture_sync: section.last_posture_sync,
    };
  }

  saveCheckpoints(cp: SentinelOneSyncCheckpoints): void {
    const raw = this.readRaw();
    const target: Record<string, any> | undefined = (this.orgId ? raw.orgs?.[this.orgId]?.sentinelone : undefined) ?? raw.sentinelone;
    // Env-var credentials: keep checkpoints in a standalone key that never
    // shadows the env configuration.
    const section = target ?? (raw.sentinelone_sync ??= {});
    if (cp.last_threat_sync !== undefined) section.last_threat_sync = cp.last_threat_sync;
    if (cp.last_alert_sync !== undefined) section.last_alert_sync = cp.last_alert_sync;
    if (cp.sync_version !== undefined) section.sync_version = cp.sync_version;
    if (cp.last_posture_sync !== undefined) section.last_posture_sync = cp.last_posture_sync;
    this.writeRaw(raw);
  }

  /** Clear checkpoints so the next sync re-runs the initial backfill. */
  resetCheckpoints(): void {
    const raw = this.readRaw();
    for (const section of [raw.sentinelone, raw.sentinelone_sync, this.orgId ? raw.orgs?.[this.orgId]?.sentinelone : undefined]) {
      if (!section) continue;
      delete section.last_threat_sync;
      delete section.last_alert_sync;
      delete section.sync_version;
    }
    this.writeRaw(raw);
  }
}
