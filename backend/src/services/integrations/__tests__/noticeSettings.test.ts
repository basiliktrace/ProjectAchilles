import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let store: string | null = null;
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

const { IntegrationsSettingsService, clampNoticeSettings } = await import('../settings.js');

describe('pre-execution notice settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store = null;
    process.env.ENCRYPTION_SECRET = 'test-encryption-secret-that-is-at-least-32-chars-long';
    mockExistsSync.mockImplementation((p: string) => (String(p).endsWith('integrations.json') ? store !== null : true));
    mockReadFileSync.mockImplementation(() => store);
    mockWriteFileSync.mockImplementation((_p: string, data: string) => { store = data; });
  });

  afterEach(() => {
    delete process.env.ENCRYPTION_SECRET;
  });

  it('returns defaults when the file has no section', () => {
    store = JSON.stringify({ alerts: { thresholds: { enabled: false }, cooldown_minutes: 15 } });
    expect(new IntegrationsSettingsService().getPreExecutionNoticeSettings()).toEqual({
      enabled: false,
      recipients: [],
      lead_minutes: 5,
      max_wait_minutes: 60,
      pickup_window_minutes: 120,
      send_finished: true,
    });
  });

  it('returns defaults when there is no file at all', () => {
    expect(new IntegrationsSettingsService().getPreExecutionNoticeSettings().lead_minutes).toBe(5);
  });

  it('clamps lead_minutes to an integer in 0..5', () => {
    expect(clampNoticeSettings({ lead_minutes: 9 }).lead_minutes).toBe(5);
    expect(clampNoticeSettings({ lead_minutes: -1 }).lead_minutes).toBe(0);
    expect(clampNoticeSettings({ lead_minutes: 2.7 }).lead_minutes).toBe(2);
    expect(clampNoticeSettings({ lead_minutes: NaN }).lead_minutes).toBe(5);
  });

  it('clamps max_wait_minutes to 15..1440 and pickup_window_minutes to 30..1440', () => {
    expect(clampNoticeSettings({ max_wait_minutes: 5 }).max_wait_minutes).toBe(15);
    expect(clampNoticeSettings({ max_wait_minutes: 99999 }).max_wait_minutes).toBe(1440);
    expect(clampNoticeSettings({ pickup_window_minutes: 5000 }).pickup_window_minutes).toBe(1440);
    expect(clampNoticeSettings({ pickup_window_minutes: 1 }).pickup_window_minutes).toBe(30);
  });

  it('round-trips a save and preserves other sections', () => {
    store = JSON.stringify({ alerts: { thresholds: { enabled: true }, cooldown_minutes: 15 } });
    const svc = new IntegrationsSettingsService();
    const saved = svc.savePreExecutionNoticeSettings({ enabled: true, recipients: ['a@x.io'], lead_minutes: 3 });
    expect(saved).toMatchObject({ enabled: true, recipients: ['a@x.io'], lead_minutes: 3, max_wait_minutes: 60 });
    expect(new IntegrationsSettingsService().getPreExecutionNoticeSettings()).toEqual(saved);
    expect(JSON.parse(store!).alerts.cooldown_minutes).toBe(15);

    // partial patch merges
    const next = svc.savePreExecutionNoticeSettings({ send_finished: false });
    expect(next).toMatchObject({ enabled: true, recipients: ['a@x.io'], send_finished: false });
  });

  it('writes to the legacy top level even when constructed with an org id', () => {
    const svc = new IntegrationsSettingsService('org_1');
    svc.savePreExecutionNoticeSettings({ enabled: true, recipients: ['a@x.io'] });
    const written = JSON.parse(store!);
    expect(written.pre_execution_notices.enabled).toBe(true);
    expect(written.orgs?.org_1?.pre_execution_notices).toBeUndefined();
    expect(new IntegrationsSettingsService().getPreExecutionNoticeSettings().enabled).toBe(true);
    expect(svc.getPreExecutionNoticeSettings().enabled).toBe(true);
  });
});
