import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mock setup ──────────────────────────────────────────────────────
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const overrides = {
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
  };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const overrides = {
    homedir: () => '/mock-home',
    hostname: () => 'test-host',
    userInfo: () => ({ username: 'testuser', uid: 1000, gid: 1000, shell: '/bin/bash', homedir: '/mock-home' }),
  };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

const { IntegrationsSettingsService } = await import('../settings.js');

const SETTINGS_DIR = '/mock-home/.projectachilles';
const SETTINGS_FILE = `${SETTINGS_DIR}/integrations.json`;

const CLIENT_ID = '0123456789abcdef0123456789abcdef';

// ── Tests ────────────────────────────────────────────────────────────

describe('IntegrationsSettingsService — CrowdStrike', () => {
  let service: InstanceType<typeof IntegrationsSettingsService>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENCRYPTION_SECRET = 'test-encryption-secret-that-is-at-least-32-chars-long';
    service = new IntegrationsSettingsService();
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_SECRET;
    delete process.env.CROWDSTRIKE_REGION;
    delete process.env.CROWDSTRIKE_CLIENT_ID;
    delete process.env.CROWDSTRIKE_CLIENT_SECRET;
    delete process.env.CROWDSTRIKE_LABEL;
  });

  // ── Encryption round-trip ────────────────────────────────────

  describe('encryption', () => {
    it('encrypt → decrypt round-trip through save/load', () => {
      let writtenData = '';
      mockWriteFileSync.mockImplementation((_p: string, data: string) => {
        writtenData = data;
      });

      service.saveCrowdStrikeSettings({
        region: 'us-2',
        client_id: CLIENT_ID,
        client_secret: 'super-secret-value',
        label: 'Falcon Production',
      });

      // Verify encrypted on disk
      const saved = JSON.parse(writtenData);
      expect(saved.crowdstrike.client_id).toMatch(/^enc:/);
      expect(saved.crowdstrike.client_secret).toMatch(/^enc:/);
      expect(saved.crowdstrike.region).toBe('us-2'); // not encrypted
      expect(saved.crowdstrike.base_url).toBeUndefined(); // never stored — derived from the region map at use time
      expect(saved.crowdstrike.label).toBe('Falcon Production'); // label not encrypted

      // Read back
      mockExistsSync.mockImplementation((p: string) => p === SETTINGS_FILE || p === SETTINGS_DIR);
      mockReadFileSync.mockReturnValue(writtenData);

      const loaded = service.getCrowdStrikeSettings();
      expect(loaded).not.toBeNull();
      expect(loaded!.region).toBe('us-2');
      expect(loaded!.client_id).toBe(CLIENT_ID);
      expect(loaded!.client_secret).toBe('super-secret-value');
      expect(loaded!.label).toBe('Falcon Production');
      expect(loaded!.configured).toBe(true);
    });

    it('defaults region to us-1 when none is given', () => {
      let writtenData = '';
      mockWriteFileSync.mockImplementation((_p: string, data: string) => {
        writtenData = data;
      });

      service.saveCrowdStrikeSettings({
        client_id: CLIENT_ID,
        client_secret: 'secret',
      });

      const saved = JSON.parse(writtenData);
      expect(saved.crowdstrike.region).toBe('us-1');
      expect(saved.crowdstrike.base_url).toBeUndefined();
    });

    it('derives the base URL from the region map in credentials (never a stored string)', () => {
      let writtenData = '';
      mockWriteFileSync.mockImplementation((_p: string, data: string) => {
        writtenData = data;
      });

      service.saveCrowdStrikeSettings({
        region: 'eu-1',
        client_id: CLIENT_ID,
        client_secret: 'secret',
      });

      mockExistsSync.mockImplementation((p: string) => p === SETTINGS_FILE || p === SETTINGS_DIR);
      mockReadFileSync.mockReturnValue(writtenData);

      const creds = service.getCrowdStrikeCredentials();
      // Credentials carry the region only — falcon-client resolves the URL.
      expect(creds).toEqual({
        region: 'eu-1',
        client_id: CLIENT_ID,
        client_secret: 'secret',
      });
    });

    it('does not interfere with Defender settings in same file', () => {
      let writtenData = '';
      mockWriteFileSync.mockImplementation((_p: string, data: string) => {
        writtenData = data;
      });

      // Save Defender first
      service.saveDefenderSettings({
        tenant_id: 'defender-tenant',
        client_id: 'defender-client',
        client_secret: 'defender-secret',
      });

      const afterDefender = writtenData;
      mockExistsSync.mockImplementation((p: string) => p === SETTINGS_FILE || p === SETTINGS_DIR);
      mockReadFileSync.mockReturnValue(afterDefender);

      // Now save CrowdStrike — should preserve Defender
      service.saveCrowdStrikeSettings({
        client_id: CLIENT_ID,
        client_secret: 'crowdstrike-secret',
      });

      // Read back and verify both exist
      mockReadFileSync.mockReturnValue(writtenData);

      const defender = service.getDefenderSettings();
      expect(defender!.tenant_id).toBe('defender-tenant');

      const crowdstrike = service.getCrowdStrikeSettings();
      expect(crowdstrike!.client_id).toBe(CLIENT_ID);
    });
  });

  // ── Environment variable override ─────────────────────────────

  describe('env var override', () => {
    it('returns env settings when file does not exist', () => {
      process.env.CROWDSTRIKE_CLIENT_ID = 'env-client-id';
      process.env.CROWDSTRIKE_CLIENT_SECRET = 'env-secret';

      const settings = service.getCrowdStrikeSettings();
      expect(settings).not.toBeNull();
      expect(settings!.client_id).toBe('env-client-id');
      expect(settings!.region).toBeUndefined(); // unset → client defaults to us-1
      expect(settings!.configured).toBe(true);
    });

    it('honors CROWDSTRIKE_REGION', () => {
      process.env.CROWDSTRIKE_REGION = 'eu-1';
      process.env.CROWDSTRIKE_CLIENT_ID = 'env-client-id';
      process.env.CROWDSTRIKE_CLIENT_SECRET = 'env-secret';

      const settings = service.getCrowdStrikeSettings();
      expect(settings!.region).toBe('eu-1');
      expect(service.getCrowdStrikeCredentials()!.region).toBe('eu-1');
    });

    it('ignores an invalid CROWDSTRIKE_REGION with a warning (falls back to us-1)', () => {
      process.env.CROWDSTRIKE_REGION = 'garbage-region';
      process.env.CROWDSTRIKE_CLIENT_ID = 'env-client-id';
      process.env.CROWDSTRIKE_CLIENT_SECRET = 'env-secret';

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const settings = service.getCrowdStrikeSettings();
      expect(settings!.region).toBeUndefined();
      expect(service.getCrowdStrikeCredentials()!.region).toBe('us-1');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('CROWDSTRIKE_REGION'));
      warnSpy.mockRestore();
    });

    it('returns null when env vars are incomplete', () => {
      process.env.CROWDSTRIKE_CLIENT_ID = 'env-client-id';
      // Missing client_secret

      const settings = service.getCrowdStrikeSettings();
      expect(settings).toBeNull();
    });

    it('reads CROWDSTRIKE_LABEL from env', () => {
      process.env.CROWDSTRIKE_CLIENT_ID = 'cid';
      process.env.CROWDSTRIKE_CLIENT_SECRET = 'secret';
      process.env.CROWDSTRIKE_LABEL = 'My Falcon Cloud';

      const settings = service.getCrowdStrikeSettings();
      expect(settings!.label).toBe('My Falcon Cloud');
    });

    it('isEnvCrowdStrikeConfigured returns true when all env vars set', () => {
      process.env.CROWDSTRIKE_CLIENT_ID = 'cid';
      process.env.CROWDSTRIKE_CLIENT_SECRET = 'secret';

      expect(service.isEnvCrowdStrikeConfigured()).toBe(true);
    });

    it('isEnvCrowdStrikeConfigured returns false when env vars missing', () => {
      expect(service.isEnvCrowdStrikeConfigured()).toBe(false);
    });
  });

  // ── File settings take priority over env ──────────────────────

  describe('precedence', () => {
    it('file settings override env vars', () => {
      process.env.CROWDSTRIKE_CLIENT_ID = 'env-client';
      process.env.CROWDSTRIKE_CLIENT_SECRET = 'env-secret';

      let writtenData = '';
      mockWriteFileSync.mockImplementation((_p: string, data: string) => {
        writtenData = data;
      });

      service.saveCrowdStrikeSettings({
        client_id: CLIENT_ID,
        client_secret: 'file-secret',
      });

      mockExistsSync.mockImplementation((p: string) => p === SETTINGS_FILE || p === SETTINGS_DIR);
      mockReadFileSync.mockReturnValue(writtenData);

      const settings = service.getCrowdStrikeSettings();
      expect(settings!.client_id).toBe(CLIENT_ID);
    });
  });

  // ── Per-org isolation ─────────────────────────────────────────

  describe('per-org isolation', () => {
    it('writes under orgs[orgId] without touching the legacy top-level section', () => {
      const orgService = new IntegrationsSettingsService('org_123');

      let writtenData = '';
      mockWriteFileSync.mockImplementation((_p: string, data: string) => {
        writtenData = data;
      });

      // Legacy top-level save first
      service.saveCrowdStrikeSettings({
        client_id: CLIENT_ID,
        client_secret: 'legacy-secret',
      });

      mockExistsSync.mockImplementation((p: string) => p === SETTINGS_FILE || p === SETTINGS_DIR);
      mockReadFileSync.mockReturnValue(writtenData);

      // Org save
      orgService.saveCrowdStrikeSettings({
        client_id: 'fedcba9876543210fedcba9876543210',
        client_secret: 'org-secret',
      });

      const saved = JSON.parse(writtenData);
      expect(saved.orgs.org_123.crowdstrike).toBeDefined();
      expect(saved.orgs.org_123.crowdstrike.client_id).toMatch(/^enc:/);
      // Legacy section preserved
      expect(saved.crowdstrike).toBeDefined();

      // Org service reads its own section (decrypted round-trip)
      mockReadFileSync.mockReturnValue(writtenData);
      const orgSettings = orgService.getCrowdStrikeSettings();
      expect(orgSettings!.client_id).toBe('fedcba9876543210fedcba9876543210');
      expect(orgSettings!.client_secret).toBe('org-secret');

      // Legacy service still reads the top-level section
      const legacySettings = service.getCrowdStrikeSettings();
      expect(legacySettings!.client_id).toBe(CLIENT_ID);
    });

    it('falls back to legacy top-level when the org has no crowdstrike section', () => {
      let writtenData = '';
      mockWriteFileSync.mockImplementation((_p: string, data: string) => {
        writtenData = data;
      });

      service.saveCrowdStrikeSettings({
        client_id: CLIENT_ID,
        client_secret: 'legacy-secret',
      });

      mockExistsSync.mockImplementation((p: string) => p === SETTINGS_FILE || p === SETTINGS_DIR);
      mockReadFileSync.mockReturnValue(writtenData);

      const orgService = new IntegrationsSettingsService('org_no_section');
      const settings = orgService.getCrowdStrikeSettings();
      expect(settings!.client_id).toBe(CLIENT_ID);
    });
  });

  // ── Partial update ────────────────────────────────────────────

  describe('partial update', () => {
    it('merges partial updates with existing settings', () => {
      let writtenData = '';
      mockWriteFileSync.mockImplementation((_p: string, data: string) => {
        writtenData = data;
      });

      // Initial save
      service.saveCrowdStrikeSettings({
        region: 'us-2',
        client_id: CLIENT_ID,
        client_secret: 'original-secret',
        label: 'Original',
      });

      // Mock file read for partial update
      mockExistsSync.mockImplementation((p: string) => p === SETTINGS_FILE || p === SETTINGS_DIR);
      mockReadFileSync.mockReturnValue(writtenData);

      // Partial update: only change the label
      service.saveCrowdStrikeSettings({ label: 'Updated Label' });

      // Read back the final state
      mockReadFileSync.mockReturnValue(writtenData);
      const loaded = service.getCrowdStrikeSettings();

      expect(loaded!.region).toBe('us-2');
      expect(loaded!.client_id).toBe(CLIENT_ID);
      expect(loaded!.client_secret).toBe('original-secret');
      expect(loaded!.label).toBe('Updated Label');
    });
  });

  // ── isCrowdStrikeConfigured ──────────────────────────────────

  describe('isCrowdStrikeConfigured', () => {
    it('returns true when file has all credentials', () => {
      let writtenData = '';
      mockWriteFileSync.mockImplementation((_p: string, data: string) => {
        writtenData = data;
      });

      service.saveCrowdStrikeSettings({
        client_id: CLIENT_ID,
        client_secret: 'secret',
      });

      mockExistsSync.mockImplementation((p: string) => p === SETTINGS_FILE || p === SETTINGS_DIR);
      mockReadFileSync.mockReturnValue(writtenData);

      expect(service.isCrowdStrikeConfigured()).toBe(true);
    });

    it('returns false when not configured', () => {
      expect(service.isCrowdStrikeConfigured()).toBe(false);
    });
  });

  // ── getCrowdStrikeCredentials ────────────────────────────────

  describe('getCrowdStrikeCredentials', () => {
    it('returns raw credentials object (region only — no stored URL)', () => {
      process.env.CROWDSTRIKE_REGION = 'us-2';
      process.env.CROWDSTRIKE_CLIENT_ID = 'cid-456';
      process.env.CROWDSTRIKE_CLIENT_SECRET = 'secret-789';

      const creds = service.getCrowdStrikeCredentials();
      expect(creds).toEqual({
        region: 'us-2',
        client_id: 'cid-456',
        client_secret: 'secret-789',
      });
    });

    it('returns null when not configured', () => {
      expect(service.getCrowdStrikeCredentials()).toBeNull();
    });
  });

  // ── Masked settings ───────────────────────────────────────────

  describe('getCrowdStrikeSettingsMasked', () => {
    it('shows client_id/label, derived base_url, and only client_secret presence', () => {
      let writtenData = '';
      mockWriteFileSync.mockImplementation((_p: string, data: string) => {
        writtenData = data;
      });

      service.saveCrowdStrikeSettings({
        region: 'eu-1',
        client_id: CLIENT_ID,
        client_secret: 'super-secret-value',
        label: 'Falcon EU',
      });

      mockExistsSync.mockImplementation((p: string) => p === SETTINGS_FILE || p === SETTINGS_DIR);
      mockReadFileSync.mockReturnValue(writtenData);

      const masked = service.getCrowdStrikeSettingsMasked();
      expect(masked.configured).toBe(true);
      expect(masked.client_id).toBe(CLIENT_ID);
      // base_url is derived from the constant region map, not stored
      expect(masked.base_url).toBe('https://api.eu-1.crowdstrike.com');
      expect(masked.region).toBe('eu-1');
      expect(masked.label).toBe('Falcon EU');
      expect(masked.client_secret_set).toBe(true);
      expect(masked.env_configured).toBe(false);
      // Never leaks the secret itself
      expect(JSON.stringify(masked)).not.toContain('super-secret-value');
    });

    it('reports env_configured and returns configured:false when nothing is set', () => {
      expect(service.getCrowdStrikeSettingsMasked()).toEqual({
        configured: false,
        env_configured: false,
      });

      process.env.CROWDSTRIKE_CLIENT_ID = 'cid';
      process.env.CROWDSTRIKE_CLIENT_SECRET = 'secret';

      const masked = service.getCrowdStrikeSettingsMasked();
      expect(masked.configured).toBe(true); // env settings resolve as configured
      expect(masked.env_configured).toBe(true);
    });
  });

  // ── Auto-resolve mode ─────────────────────────────────────────

  describe('auto_resolve_mode', () => {
    it("defaults to 'disabled' when field is missing", () => {
      process.env.CROWDSTRIKE_CLIENT_ID = 'cid';
      process.env.CROWDSTRIKE_CLIENT_SECRET = 'secret';

      expect(service.getCrowdStrikeAutoResolveMode()).toBe('disabled');
    });

    it("defaults to 'disabled' when CrowdStrike is not configured", () => {
      expect(service.getCrowdStrikeAutoResolveMode()).toBe('disabled');
    });

    it("persists 'dry_run' via setCrowdStrikeAutoResolveMode and reads it back", () => {
      let writtenData = '';
      mockWriteFileSync.mockImplementation((_p: string, data: string) => {
        writtenData = data;
      });

      // Initial credentials (required for setCrowdStrikeAutoResolveMode)
      service.saveCrowdStrikeSettings({
        client_id: CLIENT_ID,
        client_secret: 'secret',
      });

      mockExistsSync.mockImplementation((p: string) => p === SETTINGS_FILE || p === SETTINGS_DIR);
      mockReadFileSync.mockReturnValue(writtenData);

      service.setCrowdStrikeAutoResolveMode('dry_run');

      mockReadFileSync.mockReturnValue(writtenData);
      expect(service.getCrowdStrikeAutoResolveMode()).toBe('dry_run');
    });

    it("persists 'enabled' mode", () => {
      let writtenData = '';
      mockWriteFileSync.mockImplementation((_p: string, data: string) => {
        writtenData = data;
      });

      service.saveCrowdStrikeSettings({
        client_id: CLIENT_ID,
        client_secret: 'secret',
      });

      mockExistsSync.mockImplementation((p: string) => p === SETTINGS_FILE || p === SETTINGS_DIR);
      mockReadFileSync.mockReturnValue(writtenData);

      service.setCrowdStrikeAutoResolveMode('enabled');

      mockReadFileSync.mockReturnValue(writtenData);
      expect(service.getCrowdStrikeAutoResolveMode()).toBe('enabled');
    });

    it('throws on invalid mode string', () => {
      let writtenData = '';
      mockWriteFileSync.mockImplementation((_p: string, data: string) => { writtenData = data; });
      service.saveCrowdStrikeSettings({ client_id: CLIENT_ID, client_secret: 's' });
      mockExistsSync.mockImplementation((p: string) => p === SETTINGS_FILE || p === SETTINGS_DIR);
      mockReadFileSync.mockReturnValue(writtenData);

      // @ts-expect-error — testing runtime validation
      expect(() => service.setCrowdStrikeAutoResolveMode('bogus')).toThrow(/Invalid auto_resolve_mode/);
    });

    it('throws when setting mode before CrowdStrike is configured', () => {
      expect(() => service.setCrowdStrikeAutoResolveMode('dry_run')).toThrow(/not configured/);
    });

    it('setCrowdStrikeAutoResolveMode preserves existing credentials', () => {
      let writtenData = '';
      mockWriteFileSync.mockImplementation((_p: string, data: string) => { writtenData = data; });

      service.saveCrowdStrikeSettings({
        region: 'us-2',
        client_id: CLIENT_ID,
        client_secret: 'original-secret',
        label: 'Original Cloud',
      });

      mockExistsSync.mockImplementation((p: string) => p === SETTINGS_FILE || p === SETTINGS_DIR);
      mockReadFileSync.mockReturnValue(writtenData);

      service.setCrowdStrikeAutoResolveMode('dry_run');

      mockReadFileSync.mockReturnValue(writtenData);
      const settings = service.getCrowdStrikeSettings();
      expect(settings!.region).toBe('us-2');
      expect(settings!.client_id).toBe(CLIENT_ID);
      expect(settings!.client_secret).toBe('original-secret');
      expect(settings!.label).toBe('Original Cloud');
      expect(settings!.auto_resolve_mode).toBe('dry_run');
    });

    it('ignores unknown mode values read from disk (forward compat)', () => {
      // Simulate a forward-compat scenario where disk has a mode string the current code doesn't know about
      const onDisk = { crowdstrike: { region: 'us-1', client_id: 'enc:y', client_secret: 'enc:z', configured: true, auto_resolve_mode: 'future-mode-v2' } };
      mockExistsSync.mockImplementation((p: string) => p === SETTINGS_FILE || p === SETTINGS_DIR);
      mockReadFileSync.mockReturnValue(JSON.stringify(onDisk));

      // Suppress decryption console.error noise from the mock 'enc:' values
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(service.getCrowdStrikeAutoResolveMode()).toBe('disabled');
      errorSpy.mockRestore();
    });
  });

  // ── Sync timestamps ───────────────────────────────────────────

  describe('sync timestamps', () => {
    it('persists last_alert_sync/last_zta_sync/zta_status in the crowdstrike section', () => {
      let writtenData = '';
      mockWriteFileSync.mockImplementation((_p: string, data: string) => { writtenData = data; });

      service.saveCrowdStrikeSettings({
        client_id: CLIENT_ID,
        client_secret: 'secret',
      });

      mockExistsSync.mockImplementation((p: string) => p === SETTINGS_FILE || p === SETTINGS_DIR);
      mockReadFileSync.mockReturnValue(writtenData);

      service.saveCrowdStrikeSyncTimestamps({
        last_alert_sync: '2026-10-01T00:00:00Z',
        last_zta_sync: '2026-10-01T01:00:00Z',
        zta_status: 'ok',
      });

      const saved = JSON.parse(writtenData);
      expect(saved.crowdstrike.last_alert_sync).toBe('2026-10-01T00:00:00Z');
      expect(saved.crowdstrike.last_zta_sync).toBe('2026-10-01T01:00:00Z');
      expect(saved.crowdstrike.zta_status).toBe('ok');

      mockReadFileSync.mockReturnValue(writtenData);
      expect(service.getCrowdStrikeSyncTimestamps()).toEqual({
        last_alert_sync: '2026-10-01T00:00:00Z',
        last_zta_sync: '2026-10-01T01:00:00Z',
        zta_status: 'ok',
      });
    });

    it('uses the standalone crowdstrike_sync key when credentials come from env vars', () => {
      process.env.CROWDSTRIKE_CLIENT_ID = 'env-cid';
      process.env.CROWDSTRIKE_CLIENT_SECRET = 'env-secret';

      let writtenData = '';
      mockWriteFileSync.mockImplementation((_p: string, data: string) => { writtenData = data; });

      // No crowdstrike section in the file — must NOT create one (would shadow env creds)
      service.saveCrowdStrikeSyncTimestamps({ last_alert_sync: '2026-10-02T00:00:00Z' });

      const saved = JSON.parse(writtenData);
      expect(saved.crowdstrike).toBeUndefined();
      expect(saved.crowdstrike_sync).toEqual({ last_alert_sync: '2026-10-02T00:00:00Z' });

      mockExistsSync.mockImplementation((p: string) => p === SETTINGS_FILE || p === SETTINGS_DIR);
      mockReadFileSync.mockReturnValue(writtenData);

      expect(service.getCrowdStrikeSyncTimestamps()).toEqual({
        last_alert_sync: '2026-10-02T00:00:00Z',
        last_zta_sync: undefined,
        zta_status: undefined,
      });
    });

    it('returns empty object when nothing has been persisted', () => {
      expect(service.getCrowdStrikeSyncTimestamps()).toEqual({});
    });
  });

  // ── Delete ────────────────────────────────────────────────────

  describe('deleteCrowdStrikeSettings', () => {
    it('removes the crowdstrike section from the file', () => {
      let writtenData = '';
      mockWriteFileSync.mockImplementation((_p: string, data: string) => { writtenData = data; });

      service.saveCrowdStrikeSettings({
        client_id: CLIENT_ID,
        client_secret: 'secret',
      });

      mockExistsSync.mockImplementation((p: string) => p === SETTINGS_FILE || p === SETTINGS_DIR);
      mockReadFileSync.mockReturnValue(writtenData);

      service.deleteCrowdStrikeSettings();

      const saved = JSON.parse(writtenData);
      expect(saved.crowdstrike).toBeUndefined();
    });

    it('refuses when credentials are set via environment variables', () => {
      process.env.CROWDSTRIKE_CLIENT_ID = 'env-cid';
      process.env.CROWDSTRIKE_CLIENT_SECRET = 'env-secret';

      expect(() => service.deleteCrowdStrikeSettings()).toThrow(/environment variables/);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });

  // ── Error handling ────────────────────────────────────────────

  describe('error handling', () => {
    it('returns null on corrupt JSON', () => {
      mockExistsSync.mockImplementation((p: string) => p === SETTINGS_FILE || p === SETTINGS_DIR);
      mockReadFileSync.mockReturnValue('not-valid-json{{{');

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const settings = service.getCrowdStrikeSettings();
      expect(settings).toBeNull();

      errorSpy.mockRestore();
    });
  });
});
