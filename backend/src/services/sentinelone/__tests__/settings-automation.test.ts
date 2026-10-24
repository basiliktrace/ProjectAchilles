import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as realFs from 'fs';
import * as realPath from 'path';
import * as realOs from 'os';

const tmpHome = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 's1-settings-auto-'));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const overrides = { homedir: () => tmpHome };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

const { SentinelOneSettingsService } = await import('../settings.js');
const FILE = realPath.join(tmpHome, '.projectachilles', 'integrations.json');
const TOKEN = 'super-secret-token-value-0123456789';

describe('SentinelOne auto-resolve / automatic-mitigation settings', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_SECRET = 'test-encryption-secret-that-is-at-least-32-chars-long';
    delete process.env.SENTINELONE_BASE_URL;
    delete process.env.SENTINELONE_API_TOKEN;
    realFs.rmSync(realPath.join(tmpHome, '.projectachilles'), { recursive: true, force: true });
  });
  afterAll(() => realFs.rmSync(tmpHome, { recursive: true, force: true }));

  it('defaults: auto-resolve disabled, automatic mitigation disabled with action kill', () => {
    const svc = new SentinelOneSettingsService();
    svc.saveSettings({ base_url: 'https://acme.sentinelone.net', api_token: TOKEN, permission_mode: 'response' });
    expect(svc.getAutoResolveMode()).toBe('disabled');
    expect(svc.getAutoMitigation()).toEqual({ mode: 'disabled', action: 'kill' });
    expect(svc.getMasked()).toMatchObject({ auto_resolve_mode: 'disabled', auto_mitigation: { mode: 'disabled', action: 'kill' } });
  });

  it('a stored file without the new keys reads as safe defaults (existing installs)', () => {
    const svc = new SentinelOneSettingsService();
    svc.saveSettings({ base_url: 'https://acme.sentinelone.net', api_token: TOKEN, permission_mode: 'response' });
    const raw = JSON.parse(realFs.readFileSync(FILE, 'utf8'));
    delete raw.sentinelone.auto_resolve_mode;
    delete raw.sentinelone.auto_mitigation;
    realFs.writeFileSync(FILE, JSON.stringify(raw));
    expect(svc.getAutoResolveMode()).toBe('disabled');
    expect(svc.getAutoMitigation().mode).toBe('disabled');
  });

  it('auto-resolve: dry_run allowed in read-only; enabled requires Response mode', () => {
    const svc = new SentinelOneSettingsService();
    svc.saveSettings({ base_url: 'https://acme.sentinelone.net', api_token: TOKEN });
    svc.setAutoResolveMode('dry_run');
    expect(svc.getAutoResolveMode()).toBe('dry_run');
    expect(() => svc.setAutoResolveMode('enabled')).toThrow(/Response mode/);
    svc.saveSettings({ permission_mode: 'response' });
    svc.setAutoResolveMode('enabled');
    expect(svc.getAutoResolveMode()).toBe('enabled');
    expect(() => svc.setAutoResolveMode('bogus' as never)).toThrow(/Invalid/);
  });

  it('automatic mitigation: refused outside Response mode, only kill / quarantine', () => {
    const svc = new SentinelOneSettingsService();
    svc.saveSettings({ base_url: 'https://acme.sentinelone.net', api_token: TOKEN });
    expect(() => svc.setAutoMitigation({ mode: 'dry_run' })).toThrow(/Response mode/);
    expect(() => svc.setAutoMitigation({ mode: 'enabled' })).toThrow(/Response mode/);
    svc.setAutoMitigation({ action: 'quarantine' }); // changing the action alone is fine
    svc.saveSettings({ permission_mode: 'response' });
    expect(svc.setAutoMitigation({ mode: 'enabled' })).toEqual({ mode: 'enabled', action: 'quarantine' });
    expect(() => svc.setAutoMitigation({ action: 'remediate' as never })).toThrow(/Allowed: kill, quarantine/);
    expect(() => svc.setAutoMitigation({ action: 'disconnect' as never })).toThrow();
  });

  it('downgrading to read-only switches automatic mitigation off (and it reads off even if tampered)', () => {
    const svc = new SentinelOneSettingsService();
    svc.saveSettings({ base_url: 'https://acme.sentinelone.net', api_token: TOKEN, permission_mode: 'response' });
    svc.setAutoMitigation({ mode: 'enabled', action: 'kill' });
    svc.saveSettings({ permission_mode: 'read_only' });
    expect(JSON.parse(realFs.readFileSync(FILE, 'utf8')).sentinelone.auto_mitigation.mode).toBe('disabled');

    const raw = JSON.parse(realFs.readFileSync(FILE, 'utf8'));
    raw.sentinelone.auto_mitigation = { mode: 'enabled', action: 'kill' };
    realFs.writeFileSync(FILE, JSON.stringify(raw));
    expect(svc.getAutoMitigation().mode).toBe('disabled');
  });

  it('settings saves preserve the toggles and never put the token in plain text', () => {
    const svc = new SentinelOneSettingsService();
    svc.saveSettings({ base_url: 'https://acme.sentinelone.net', api_token: TOKEN, permission_mode: 'response' });
    svc.setAutoResolveMode('dry_run');
    svc.saveSettings({ poll_interval_minutes: 10 });
    expect(svc.getAutoResolveMode()).toBe('dry_run');
    expect(realFs.readFileSync(FILE, 'utf8')).not.toContain(TOKEN);
  });
});
