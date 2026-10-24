import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as realFs from 'fs';
import * as realPath from 'path';
import * as realOs from 'os';

const tmpHome = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 's1-settings-'));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const overrides = { homedir: () => tmpHome };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

const { SentinelOneSettingsService } = await import('../settings.js');
const FILE = realPath.join(tmpHome, '.projectachilles', 'integrations.json');
const TOKEN = 'super-secret-token-value-0123456789';

describe('SentinelOneSettingsService', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_SECRET = 'test-encryption-secret-that-is-at-least-32-chars-long';
    delete process.env.SENTINELONE_BASE_URL;
    delete process.env.SENTINELONE_API_TOKEN;
    realFs.rmSync(realPath.join(tmpHome, '.projectachilles'), { recursive: true, force: true });
  });
  afterAll(() => realFs.rmSync(tmpHome, { recursive: true, force: true }));

  it('encrypts the token at rest, preserves other integrations, and applies defaults', () => {
    realFs.mkdirSync(realPath.dirname(FILE), { recursive: true });
    realFs.writeFileSync(FILE, JSON.stringify({ crowdstrike: { client_id: 'enc:x', configured: true } }));

    const svc = new SentinelOneSettingsService();
    svc.saveSettings({ base_url: 'https://acme.sentinelone.net/', api_token: TOKEN });

    const raw = realFs.readFileSync(FILE, 'utf8');
    expect(raw).not.toContain(TOKEN);
    const parsed = JSON.parse(raw);
    expect(parsed.crowdstrike).toEqual({ client_id: 'enc:x', configured: true });
    expect(parsed.sentinelone.api_token.startsWith('enc:')).toBe(true);

    expect(svc.getCredentials()).toEqual({ base_url: 'https://acme.sentinelone.net', api_token: TOKEN, permission_mode: 'read_only' });
    const masked = svc.getMasked();
    expect(masked).toMatchObject({ configured: true, permission_mode: 'read_only', poll_interval_minutes: 5, backfill_days: 365, api_token_set: true });
    expect(JSON.stringify(masked)).not.toContain(TOKEN);
  });

  it('partial update keeps the token and resets checkpoints when scope changes', () => {
    const svc = new SentinelOneSettingsService();
    svc.saveSettings({ base_url: 'https://acme.sentinelone.net', api_token: TOKEN });
    svc.saveCheckpoints({ last_threat_sync: '2026-01-01T00:00:00.000Z', sync_version: 1 });

    svc.saveSettings({ permission_mode: 'response' });
    expect(svc.getCredentials()?.api_token).toBe(TOKEN);
    expect(svc.getPermissionMode()).toBe('response');
    expect(svc.getCheckpoints().last_threat_sync).toBe('2026-01-01T00:00:00.000Z');

    svc.saveSettings({ scope: { account_ids: ['123'] } });
    expect(svc.getCheckpoints().last_threat_sync).toBeUndefined();
  });

  it('rejects non-SentinelOne hosts', () => {
    const svc = new SentinelOneSettingsService();
    expect(() => svc.saveSettings({ base_url: 'https://evil.example.com', api_token: TOKEN })).toThrow();
  });

  it('isolates per-org settings', () => {
    new SentinelOneSettingsService('org_a').saveSettings({ base_url: 'https://a.sentinelone.net', api_token: TOKEN });
    expect(new SentinelOneSettingsService('org_a').isConfigured()).toBe(true);
    expect(new SentinelOneSettingsService('org_b').isConfigured()).toBe(false);
  });

  it('falls back to env vars and refuses deletion of env config', () => {
    process.env.SENTINELONE_BASE_URL = 'https://env.sentinelone.net';
    process.env.SENTINELONE_API_TOKEN = TOKEN;
    const svc = new SentinelOneSettingsService();
    expect(svc.getCredentials()).toMatchObject({ base_url: 'https://env.sentinelone.net', permission_mode: 'read_only' });
    expect(() => svc.deleteSettings()).toThrow(/environment variables/);
  });
});
