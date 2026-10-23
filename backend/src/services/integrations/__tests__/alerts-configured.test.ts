import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Real filesystem under a temp HOME (no fs mocking).
let tmpHome: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const overrides = { homedir: () => tmpHome };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-alerts-cfg-'));
const { IntegrationsSettingsService } = await import('../settings.js');

const settingsFile = () => path.join(tmpHome, '.projectachilles', 'integrations.json');

/** Exact payload shape AlertsConfig.tsx sends: no `configured` field. */
function uiPayload() {
  return {
    thresholds: { enabled: true, defense_score_min: 90 },
    cooldown_minutes: 15,
    email: {
      enabled: true,
      smtp_host: 'smtp.example.com',
      smtp_port: 587,
      smtp_secure: false,
      smtp_user: 'user',
      smtp_pass: 'pass',
      from_address: 'alerts@example.com',
      recipients: ['ops@example.com'],
    },
    slack: { enabled: true, webhook_url: 'https://hooks.slack.com/services/T/B/x' },
  };
}

describe('alert channel `configured` is derived server-side', () => {
  let service: InstanceType<typeof IntegrationsSettingsService>;

  beforeEach(() => {
    fs.rmSync(path.join(tmpHome, '.projectachilles'), { recursive: true, force: true });
    process.env.ENCRYPTION_SECRET = 'test-encryption-secret-that-is-at-least-32-chars-long';
    service = new IntegrationsSettingsService();
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_SECRET;
    fs.rmSync(path.join(tmpHome, '.projectachilles'), { recursive: true, force: true });
  });

  it('UI save payload (no configured) reads back configured=true for both channels', () => {
    service.saveAlertSettings(uiPayload() as never);
    const s = service.getAlertSettings()!;
    expect(s.email?.configured).toBe(true);
    expect(s.slack?.configured).toBe(true);
    expect(s.email?.enabled).toBe(true);
    expect(s.slack?.enabled).toBe(true);
    expect(service.isAlertingConfigured()).toBe(true);
  });

  it('persists the derived flag to disk', () => {
    service.saveAlertSettings(uiPayload() as never);
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    expect(raw.alerts.email.configured).toBe(true);
    expect(raw.alerts.slack.configured).toBe(true);
  });

  it('keeps enabled as the user set it (configured but disabled)', () => {
    const p = uiPayload();
    p.email.enabled = false;
    p.slack.enabled = false;
    service.saveAlertSettings(p as never);
    const s = service.getAlertSettings()!;
    expect(s.email?.configured).toBe(true);
    expect(s.email?.enabled).toBe(false);
    expect(s.slack?.configured).toBe(true);
    expect(s.slack?.enabled).toBe(false);
    expect(service.isAlertingConfigured()).toBe(false);
  });

  it('ignores client configured:true when fields are empty', () => {
    const p = uiPayload();
    p.email.smtp_host = '';
    p.slack.webhook_url = '';
    service.saveAlertSettings({
      ...p,
      email: { ...p.email, configured: true },
      slack: { ...p.slack, configured: true },
    } as never);
    const s = service.getAlertSettings()!;
    expect(s.email?.configured).toBe(false);
    expect(s.slack?.configured).toBe(false);
  });

  it('email needs at least one recipient', () => {
    const p = uiPayload();
    p.email.recipients = [];
    service.saveAlertSettings(p as never);
    expect(service.getAlertSettings()!.email?.configured).toBe(false);
  });

  it('email needs a non-blank from_address', () => {
    const p = uiPayload();
    p.email.from_address = '   ';
    service.saveAlertSettings(p as never);
    expect(service.getAlertSettings()!.email?.configured).toBe(false);
  });

  it('normalises a legacy file saved with configured:false on read (no re-save)', () => {
    service.saveAlertSettings(uiPayload() as never);
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    raw.alerts.email.configured = false;
    raw.alerts.slack.configured = false;
    fs.writeFileSync(settingsFile(), JSON.stringify(raw));

    const s = new IntegrationsSettingsService().getAlertSettings()!;
    expect(s.email?.configured).toBe(true);
    expect(s.slack?.configured).toBe(true);
  });

  it('normalises a stale configured:true with an empty webhook to false on read', () => {
    service.saveAlertSettings(uiPayload() as never);
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    raw.alerts.slack.webhook_url = '';
    raw.alerts.slack.configured = true;
    fs.writeFileSync(settingsFile(), JSON.stringify(raw));
    expect(new IntegrationsSettingsService().getAlertSettings()!.slack?.configured).toBe(false);
  });

  it('per-org section: save derives configured and stale false on disk is fixed on read', () => {
    const orgService = new IntegrationsSettingsService('org_123');
    orgService.saveAlertSettings(uiPayload() as never);
    let s = orgService.getAlertSettings()!;
    expect(s.email?.configured).toBe(true);
    expect(s.slack?.configured).toBe(true);

    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    expect(raw.orgs.org_123.alerts.email.configured).toBe(true);
    raw.orgs.org_123.alerts.email.configured = false;
    raw.orgs.org_123.alerts.slack.configured = false;
    fs.writeFileSync(settingsFile(), JSON.stringify(raw));

    s = new IntegrationsSettingsService('org_123').getAlertSettings()!;
    expect(s.email?.configured).toBe(true);
    expect(s.slack?.configured).toBe(true);
  });
});
