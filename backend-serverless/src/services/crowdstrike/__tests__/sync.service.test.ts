// Mirrors backend/src/services/crowdstrike/__tests__/sync.service.test.ts.
// Fork differences: settings service is async (Blob) — mocked methods return
// plain values, which await fine; runEnrichmentPass is private in the fork
// (cron only calls syncAll), so enrichment is exercised through syncAll.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ──────────────────────────────────────────────────────

// Mock Falcon client. FalconApiError must remain a real distinguishable
// error class — syncZtaScores branches on `instanceof FalconApiError &&
// statusCode === 403` for the not-licensed path.
const mockGetAlertsCombined = vi.fn();
const mockGetZtaDeviceIds = vi.fn();
const mockGetZtaAssessments = vi.fn();

class MockFalconApiError extends Error {
  constructor(message: string, readonly statusCode: number, readonly bodySnippet: string) {
    super(message);
    this.name = 'FalconApiError';
  }
}

vi.mock('../falcon-client.js', () => ({
  FalconClient: class {
    getAlertsCombined = mockGetAlertsCombined;
    getZtaDeviceIds = mockGetZtaDeviceIds;
    getZtaAssessments = mockGetZtaAssessments;
  },
  FalconApiError: MockFalconApiError,
  CROWDSTRIKE_REGION_BASE_URLS: {
    'us-1': 'https://api.crowdstrike.com',
    'us-2': 'https://api.us-2.crowdstrike.com',
    'eu-1': 'https://api.eu-1.crowdstrike.com',
    'us-gov-1': 'https://api.laggar.gcw.crowdstrike.com',
  },
  DEFAULT_CROWDSTRIKE_BASE_URL: 'https://api.crowdstrike.com',
}));

// Mock integrations settings.
let mockAutoResolveMode: 'disabled' | 'dry_run' | 'enabled' = 'disabled';
const mockGetCrowdStrikeSyncTimestamps = vi.fn().mockReturnValue({});
const mockSaveCrowdStrikeSyncTimestamps = vi.fn();
let mockConfigured = true;
vi.mock('../../integrations/settings.js', () => ({
  IntegrationsSettingsService: class {
    getCrowdStrikeCredentials = async () => ({
      base_url: 'https://api.crowdstrike.com',
      client_id: 'a'.repeat(32),
      client_secret: 'test-secret',
    });
    isCrowdStrikeConfigured = async () => mockConfigured;
    getCrowdStrikeAutoResolveMode = async () => mockAutoResolveMode;
    getCrowdStrikeSyncTimestamps = mockGetCrowdStrikeSyncTimestamps;
    saveCrowdStrikeSyncTimestamps = mockSaveCrowdStrikeSyncTimestamps;
  },
}));

// Mock index management
vi.mock('../index-management.js', () => ({
  ensureCrowdStrikeIndex: vi.fn().mockResolvedValue(undefined),
  ensureCrowdStrikeIndexMappings: vi.fn().mockResolvedValue(undefined),
  CROWDSTRIKE_INDEX: 'achilles-crowdstrike',
}));

// Mock analytics settings + client
const mockBulk = vi.fn();

vi.mock('../../analytics/settings.js', () => ({
  SettingsService: class {
    getSettings = async () => ({ configured: true, connectionType: 'node', node: 'http://localhost:9200', indexPattern: 'achilles-results-*' });
  },
}));

vi.mock('../../analytics/client.js', () => ({
  createEsClient: () => ({
    bulk: mockBulk,
  }),
}));

// Mock enrichment service
vi.mock('../enrichment.service.js', () => ({
  CrowdStrikeEnrichmentService: class {
    async runEnrichmentPass() {
      return {
        scanned: 0,
        detected: 0,
        stageDetected: 0,
        skipped: 0,
        batches: 0,
        alertsMarkedCorrelated: 0,
        errors: [],
        durationMs: 0,
      };
    }
  },
}));

// Mock auto-resolve service. Exposes the call count via a shared spy so
// tests can assert that syncAll() actually invokes it.
const mockAutoResolveRun = vi.fn().mockResolvedValue({
  mode: 'disabled',
  candidates: 0,
  patched: 0,
  wouldPatch: 0,
  skipped: 0,
  errors: [],
  durationMs: 0,
});
vi.mock('../auto-resolve.service.js', () => ({
  CrowdStrikeAutoResolveService: class {
    runAutoResolvePass = mockAutoResolveRun;
  },
}));

const { CrowdStrikeSyncService } = await import('../sync.service.js');
const { ensureCrowdStrikeIndex } = await import('../index-management.js');

// ── Fixtures ─────────────────────────────────────────────────────────

const falconAlert = (overrides: Record<string, unknown> = {}) => ({
  composite_id: 'alert-123',
  cid: 'test-cid',
  display_name: 'Suspicious Process Execution',
  description: 'A suspicious process was executed',
  severity: 70,
  severity_name: 'High',
  status: 'new',
  device: { hostname: 'LT-TPL-L50' },
  filename: '92B0B4F6-A09B-4C7B-B593-31CE461F804C.EXE',
  filepath: 'C:\\F0\\Tasks\\92B0B4F6-A09B-4C7B-B593-31CE461F804C.EXE',
  technique: 'Command and Scripting Interpreter',
  technique_id: 'T1059',
  mitre_attack: [{ technique_id: 'T1059' }, { technique_id: 'T1059.001' }],
  product: 'epp',
  scenario: 'suspicious_activity',
  created_timestamp: '2026-10-01T12:00:00Z',
  updated_timestamp: '2026-10-01T12:05:00Z',
  ...overrides,
});

const emptyPage = { resources: [], after: undefined, total: 0 };

// ── Tests ────────────────────────────────────────────────────────────

describe('CrowdStrikeSyncService (serverless)', () => {
  let service: InstanceType<typeof CrowdStrikeSyncService>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new CrowdStrikeSyncService();
    mockAutoResolveMode = 'disabled';
    mockConfigured = true;
    mockGetCrowdStrikeSyncTimestamps.mockReturnValue({});

    // Default: no errors in bulk responses
    mockBulk.mockResolvedValue({ errors: false, items: [] });
  });

  // ── syncAlerts ─────────────────────────────────────────────────

  describe('syncAlerts', () => {
    it('syncs alerts to ES with update + doc_as_upsert (f0rtika.* survives re-ingestion)', async () => {
      mockGetAlertsCombined.mockResolvedValue({ resources: [falconAlert()], after: undefined, total: 1 });

      const result = await service.syncAlerts();
      expect(result.synced).toBe(1);

      const operations = mockBulk.mock.calls[0][0].operations;
      expect(operations[0]).toMatchObject({
        update: { _index: 'achilles-crowdstrike', _id: 'alert-alert-123', retry_on_conflict: 3 },
      });
      expect(operations[1]).toMatchObject({ doc_as_upsert: true });
      expect(operations[1].doc.f0rtika).toBeUndefined();
      expect(operations[1].doc).toMatchObject({ alert_id: 'alert-123', doc_type: 'alert' });
    });

    it('maps Falcon alert fields onto the vendor-neutral ES doc shape', async () => {
      mockGetAlertsCombined.mockResolvedValue({
        resources: [falconAlert()],
        after: undefined,
        total: 1,
      });

      await service.syncAlerts();

      const doc = mockBulk.mock.calls[0][0].operations[1].doc;
      expect(doc.alert_title).toBe('Suspicious Process Execution');
      expect(doc.severity).toBe('high'); // severity_name lowercased
      expect(doc.status).toBe('new');
      expect(doc.category).toBe('suspicious_activity'); // scenario || product
      expect(doc.service_source).toBe('CrowdStrike Falcon');
      expect(doc.mitre_techniques).toEqual(['T1059', 'T1059.001']); // deduped
      expect(doc.created_at).toBe('2026-10-01T12:00:00Z');
      expect(doc.resolved_at).toBeNull(); // status != closed
      expect(doc.evidence_hostnames).toEqual(['LT-TPL-L50']);
      expect(doc.evidence_filenames).toEqual(['92b0b4f6-a09b-4c7b-b593-31ce461f804c.exe']);
      expect(doc.evidence_filepaths).toEqual(['c:\\f0\\tasks\\92b0b4f6-a09b-4c7b-b593-31ce461f804c.exe']);
    });

    it('sets resolved_at from updated_timestamp when status is closed', async () => {
      mockGetAlertsCombined.mockResolvedValue({
        resources: [falconAlert({ status: 'closed' })],
        after: undefined,
        total: 1,
      });

      await service.syncAlerts();

      const doc = mockBulk.mock.calls[0][0].operations[1].doc;
      expect(doc.resolved_at).toBe('2026-10-01T12:05:00Z');
    });

    it('paginates via the after token until it is exhausted', async () => {
      mockGetAlertsCombined
        .mockResolvedValueOnce({ resources: [falconAlert({ composite_id: 'a1' })], after: 'page-2', total: 2 })
        .mockResolvedValueOnce({ resources: [falconAlert({ composite_id: 'a2' })], after: undefined, total: 2 });

      const result = await service.syncAlerts();

      expect(result.synced).toBe(2);
      expect(mockGetAlertsCombined).toHaveBeenCalledTimes(2);
      expect(mockGetAlertsCombined.mock.calls[1][0].after).toBe('page-2');
      expect(mockGetAlertsCombined.mock.calls[0][0].sort).toBe('created_timestamp|asc');
    });

    it('uses 90-day lookback FQL on first sync, checkpoint FQL on second', async () => {
      mockGetAlertsCombined.mockResolvedValue(emptyPage);

      await service.syncAlerts();
      expect(mockGetAlertsCombined.mock.calls[0][0].filter).toMatch(/^created_timestamp:>='/);

      const checkpoint = service.getSyncStatus().lastAlertSync;
      expect(checkpoint).not.toBeNull();
      mockGetAlertsCombined.mockClear();
      await service.syncAlerts();
      expect(mockGetAlertsCombined.mock.calls[0][0].filter).toBe(`created_timestamp:>='${checkpoint}'`);
    });

    it('forces a full re-sync when the persisted sync_version is stale', async () => {
      mockGetCrowdStrikeSyncTimestamps.mockReturnValue({
        last_alert_sync: '2026-09-01T00:00:00Z',
        sync_version: 0, // older than CROWDSTRIKE_ALERT_SYNC_VERSION
      });
      mockGetAlertsCombined.mockResolvedValue(emptyPage);

      const freshService = new CrowdStrikeSyncService();
      await freshService.syncAlerts();

      const filter = mockGetAlertsCombined.mock.calls[0][0].filter as string;
      expect(filter).not.toContain('2026-09-01T00:00:00Z');
    });

    it('persists sync_version with the timestamps', async () => {
      mockGetAlertsCombined.mockResolvedValue(emptyPage);

      await service.syncAlerts();

      expect(mockSaveCrowdStrikeSyncTimestamps).toHaveBeenCalledWith(
        expect.objectContaining({ sync_version: expect.any(Number), last_alert_sync: expect.any(String) }),
      );
    });

    it('reports Falcon API errors', async () => {
      mockGetAlertsCombined.mockRejectedValue(new Error('Falcon API down'));

      const result = await service.syncAlerts();
      expect(result.synced).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Falcon API down');
    });
  });

  // ── syncZtaScores ──────────────────────────────────────────────

  describe('syncZtaScores', () => {
    const ztaAssessment = (aid: string, overall: number, os = 80, sensorConfig = 90) => ({
      aid,
      cid: 'test-cid',
      assessment: { overall, os, sensor_config: sensorConfig },
    });

    it('aggregates per-device assessments into a daily snapshot doc', async () => {
      mockGetZtaDeviceIds.mockResolvedValue({ resources: ['aid-1', 'aid-2', 'aid-3'], after: undefined, total: 3 });
      mockGetZtaAssessments.mockResolvedValue([
        ztaAssessment('aid-1', 60),
        ztaAssessment('aid-2', 80),
        ztaAssessment('aid-3', 100),
      ]);

      const result = await service.syncZtaScores();
      expect(result.synced).toBe(1);
      expect(result.errors).toHaveLength(0);

      const operations = mockBulk.mock.calls[0][0].operations;
      expect(operations[0].index._index).toBe('achilles-crowdstrike');
      expect(operations[0].index._id).toMatch(/^score-\d{4}-\d{2}-\d{2}$/);

      const doc = operations[1];
      expect(doc.doc_type).toBe('zta_score');
      expect(doc.overall_score).toBeCloseTo(80);
      expect(doc.min_score).toBe(60);
      expect(doc.max_score).toBe(100);
      expect(doc.device_count).toBe(3);
      expect(doc.os_score).toBeCloseTo(80);
      expect(doc.sensor_config_score).toBeCloseTo(90);
    });

    it('paginates device AIDs before fetching assessments', async () => {
      mockGetZtaDeviceIds
        .mockResolvedValueOnce({ resources: ['aid-1'], after: 'zta-page-2', total: 2 })
        .mockResolvedValueOnce({ resources: ['aid-2'], after: undefined, total: 2 });
      mockGetZtaAssessments.mockResolvedValue([
        ztaAssessment('aid-1', 50),
        ztaAssessment('aid-2', 70),
      ]);

      await service.syncZtaScores();

      expect(mockGetZtaDeviceIds).toHaveBeenCalledTimes(2);
      expect(mockGetZtaDeviceIds.mock.calls[1][0].after).toBe('zta-page-2');
      expect(mockGetZtaAssessments).toHaveBeenCalledWith(['aid-1', 'aid-2']);
    });

    it('writes no doc when there are no devices', async () => {
      mockGetZtaDeviceIds.mockResolvedValue({ resources: [], after: undefined, total: 0 });

      const result = await service.syncZtaScores();

      expect(result.synced).toBe(0);
      expect(mockGetZtaAssessments).not.toHaveBeenCalled();
      expect(mockBulk).not.toHaveBeenCalled();
    });

    it('403 from the ZTA API is non-fatal and records zta_status=not_licensed', async () => {
      // ZTA requires Falcon Insight licensing — a 403 means "not licensed",
      // not a broken credential. The rest of the integration must be unaffected.
      mockGetZtaDeviceIds.mockRejectedValue(new MockFalconApiError('forbidden', 403, 'access denied'));

      const result = await service.syncZtaScores();

      expect(result.synced).toBe(0);
      expect(result.errors).toHaveLength(0); // non-fatal by design
      expect(mockSaveCrowdStrikeSyncTimestamps).toHaveBeenCalledWith(
        expect.objectContaining({ zta_status: 'not_licensed' }),
      );
      expect(service.getSyncStatus().ztaStatus).toBe('not_licensed');
    });

    it('records zta_status=ok on success', async () => {
      mockGetZtaDeviceIds.mockResolvedValue({ resources: ['aid-1'], after: undefined, total: 1 });
      mockGetZtaAssessments.mockResolvedValue([ztaAssessment('aid-1', 75)]);

      await service.syncZtaScores();

      expect(mockSaveCrowdStrikeSyncTimestamps).toHaveBeenCalledWith(
        expect.objectContaining({ zta_status: 'ok', last_zta_sync: expect.any(String) }),
      );
      expect(service.getSyncStatus().ztaStatus).toBe('ok');
    });
  });

  // ── syncAll ────────────────────────────────────────────────────

  describe('syncAll', () => {
    it('runs alerts + zta syncs, enrichment, and auto-resolve passes', async () => {
      mockGetAlertsCombined.mockResolvedValue(emptyPage);
      mockGetZtaDeviceIds.mockResolvedValue({ resources: [], after: undefined, total: 0 });

      const result = await service.syncAll();

      expect(result.alerts).toBeDefined();
      expect(result.zta).toBeDefined();
      expect(result.enrichment).toBeDefined();
      expect(result.enrichment.scanned).toBe(0);
      expect(result.autoResolve).toBeDefined();
      expect(result.autoResolve.mode).toBe('disabled');
      expect(result.timestamp).toBeDefined();
    });

    it('syncAll() invokes the auto-resolve pass when mode is enabled — single call per sync cycle', async () => {
      mockAutoResolveMode = 'enabled';
      mockGetAlertsCombined.mockResolvedValue(emptyPage);
      mockGetZtaDeviceIds.mockResolvedValue({ resources: [], after: undefined, total: 0 });

      await service.syncAll();

      expect(mockAutoResolveRun).toHaveBeenCalledTimes(1);
    });

    it('no-ops enrichment + auto-resolve when CrowdStrike is not configured', async () => {
      mockConfigured = false;
      mockAutoResolveMode = 'enabled';
      mockGetAlertsCombined.mockResolvedValue(emptyPage);
      mockGetZtaDeviceIds.mockResolvedValue({ resources: [], after: undefined, total: 0 });

      const result = await service.syncAll();

      expect(result.enrichment.scanned).toBe(0);
      expect(result.enrichment.errors).toEqual([]);
      // Auto-resolve wrapper short-circuits before instantiating the inner service
      expect(mockAutoResolveRun).not.toHaveBeenCalled();
      expect(result.autoResolve.candidates).toBe(0);
    });
  });

  // ── runAutoResolvePass (public — invoked via syncAll from the cron route) ──

  describe('runAutoResolvePass', () => {
    beforeEach(() => {
      mockAutoResolveMode = 'disabled';
      mockAutoResolveRun.mockClear();
    });

    it("returns a 'disabled' result without instantiating the inner service when mode is disabled", async () => {
      const result = await service.runAutoResolvePass();

      expect(result.mode).toBe('disabled');
      expect(result.candidates).toBe(0);
      expect(mockAutoResolveRun).not.toHaveBeenCalled();
    });

    it('runs the inner service when mode is dry_run', async () => {
      mockAutoResolveMode = 'dry_run';
      mockAutoResolveRun.mockResolvedValueOnce({
        mode: 'dry_run', candidates: 2, patched: 0, wouldPatch: 2,
        skipped: 0, errors: [], durationMs: 5,
      });

      const result = await service.runAutoResolvePass();

      expect(mockAutoResolveRun).toHaveBeenCalledTimes(1);
      expect(result.mode).toBe('dry_run');
      expect(result.wouldPatch).toBe(2);
    });

    it('captures inner-service errors into the result rather than throwing', async () => {
      mockAutoResolveMode = 'enabled';
      mockAutoResolveRun.mockRejectedValueOnce(new Error('falcon offline'));

      const result = await service.runAutoResolvePass();

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('falcon offline');
    });
  });

  // ── getSyncStatus ──────────────────────────────────────────────

  describe('getSyncStatus', () => {
    it('tracks sync timestamps', async () => {
      mockGetAlertsCombined.mockResolvedValue(emptyPage);

      const statusBefore = service.getSyncStatus();
      expect(statusBefore.lastAlertSync).toBeNull();

      await service.syncAlerts();

      const statusAfter = service.getSyncStatus();
      expect(statusAfter.lastAlertSync).not.toBeNull();
    });
  });

  // ── Setup failures (ES privileges, missing creds) ──────────────

  describe('setup failures', () => {
    const PRIV_ERROR = 'security_exception: action [indices:admin/create] is unauthorized for API key id [abc]';

    it('syncAlerts returns an index-setup failure as a result error instead of throwing', async () => {
      vi.mocked(ensureCrowdStrikeIndex).mockRejectedValueOnce(new Error(PRIV_ERROR));

      const result = await service.syncAlerts();

      expect(result.synced).toBe(0);
      expect(result.errors[0]).toContain('indices:admin/create');
      expect(mockGetAlertsCombined).not.toHaveBeenCalled();
    });

    it('records lastError and lastAttemptAt for the failing stage', async () => {
      vi.mocked(ensureCrowdStrikeIndex).mockRejectedValueOnce(new Error(PRIV_ERROR));

      await service.syncAlerts();
      const status = service.getSyncStatus();

      expect(status.lastAttemptAt).not.toBeNull();
      expect(status.lastError).toMatchObject({ stage: 'alerts' });
      expect(status.lastError?.message).toContain('indices:admin/create');
      expect(status.lastAlertSync).toBeNull();
    });

    it('clears lastError once the same stage succeeds', async () => {
      vi.mocked(ensureCrowdStrikeIndex).mockRejectedValueOnce(new Error(PRIV_ERROR));
      await service.syncAlerts();
      expect(service.getSyncStatus().lastError).not.toBeNull();

      mockGetAlertsCombined.mockResolvedValue(emptyPage);
      await service.syncAlerts();
      expect(service.getSyncStatus().lastError).toBeNull();
    });

    it('syncAll resolves and records lastSyncResult even when every stage fails setup', async () => {
      vi.mocked(ensureCrowdStrikeIndex).mockRejectedValue(new Error(PRIV_ERROR));

      const result = await service.syncAll();

      expect(result.alerts.errors).toHaveLength(1);
      expect(result.zta.errors).toHaveLength(1);
      expect(service.getSyncStatus().lastSyncResult).toEqual(result);

      vi.mocked(ensureCrowdStrikeIndex).mockResolvedValue(undefined);
    });
  });
});
