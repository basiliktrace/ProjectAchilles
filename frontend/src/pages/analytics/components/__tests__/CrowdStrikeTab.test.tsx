import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockCrowdstrikeApi = {
  getZtaScore: vi.fn(),
  getZtaScoreTrend: vi.fn(),
  getAlertSummary: vi.fn(),
  getAlertTrend: vi.fn(),
  getDetectionRate: vi.fn(),
  getTechniqueOverlap: vi.fn(),
};
const mockGetSyncStatus = vi.fn();
const mockGetAutoResolveStatus = vi.fn();
const mockGetAutoResolveReceipts = vi.fn();
const mockGetDefenseScoreTrend = vi.fn();

vi.mock('@/services/api/crowdstrike', () => ({
  crowdstrikeApi: {
    getZtaScore: () => mockCrowdstrikeApi.getZtaScore(),
    getZtaScoreTrend: (days: number) => mockCrowdstrikeApi.getZtaScoreTrend(days),
    getAlertSummary: () => mockCrowdstrikeApi.getAlertSummary(),
    getAlertTrend: (days: number) => mockCrowdstrikeApi.getAlertTrend(days),
    getDetectionRate: (days: number, windowMinutes: number) =>
      mockCrowdstrikeApi.getDetectionRate(days, windowMinutes),
    getTechniqueOverlap: () => mockCrowdstrikeApi.getTechniqueOverlap(),
  },
}));

vi.mock('@/services/api/integrations', () => ({
  integrationsApi: {
    getCrowdStrikeSyncStatus: () => mockGetSyncStatus(),
    triggerCrowdStrikeSync: vi.fn(),
    getCrowdStrikeAutoResolveStatus: () => mockGetAutoResolveStatus(),
    getCrowdStrikeAutoResolveReceipts: () => mockGetAutoResolveReceipts(),
  },
}));

vi.mock('@/services/api/analytics', () => ({
  analyticsApi: {
    getDefenseScoreTrend: (params: unknown) => mockGetDefenseScoreTrend(params),
  },
}));

// Recharts uses ResizeObserver under the hood
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;

const { default: CrowdStrikeTab } = await import('../CrowdStrikeTab');

function mockHappyPath() {
  mockCrowdstrikeApi.getZtaScore.mockResolvedValue({
    overallScore: 82.5,
    osScore: 90,
    sensorConfigScore: 75,
    deviceCount: 12,
  });
  mockCrowdstrikeApi.getZtaScoreTrend.mockResolvedValue([
    { date: '2026-09-12', overallScore: 80, deviceCount: 12 },
    { date: '2026-10-11', overallScore: 82.5, deviceCount: 12 },
  ]);
  mockCrowdstrikeApi.getAlertSummary.mockResolvedValue({
    total: 42,
    bySeverity: { critical: 3, high: 10, medium: 20, low: 9 },
    byStatus: { new: 30, closed: 12 },
    recentHigh: [],
    recentMedium: [],
  });
  mockCrowdstrikeApi.getAlertTrend.mockResolvedValue([]);
  mockCrowdstrikeApi.getDetectionRate.mockResolvedValue({
    overall: {
      detectionRate: 66.7,
      totalExecutions: 9,
      correlatedExecutions: 6,
      testedTechniques: 4,
      detectedTechniques: 3,
    },
    byTechnique: [{ technique: 'T1059', testExecutions: 5, correlatedExecutions: 4, detected: true }],
  });
  mockCrowdstrikeApi.getTechniqueOverlap.mockResolvedValue([]);
  mockGetDefenseScoreTrend.mockResolvedValue([]);
  mockGetAutoResolveStatus.mockResolvedValue({
    mode: 'disabled',
    counts: { last24h: 0, last7d: 0, last30d: 0 },
    lastAutoResolve: null,
  });
  mockGetAutoResolveReceipts.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
}

describe('CrowdStrikeTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHappyPath();
  });

  it('renders the ZTA score hero tile when score data is available', async () => {
    mockGetSyncStatus.mockResolvedValue({
      lastAlertSync: '2026-10-11T03:00:00.000Z',
      lastZtaSync: '2026-10-11T03:00:00.000Z',
      ztaStatus: 'ok',
      lastError: null,
    });

    render(<MemoryRouter><CrowdStrikeTab /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('ZTA Score')).toBeInTheDocument());
    expect(screen.getByText('82.5')).toBeInTheDocument();
    expect(screen.getByText(/12 devices/)).toBeInTheDocument();
    expect(screen.queryByText(/requires Falcon Insight licensing/)).not.toBeInTheDocument();
  });

  it('shows the not-licensed empty state when sync status reports zta_status not_licensed', async () => {
    mockGetSyncStatus.mockResolvedValue({
      lastAlertSync: '2026-10-11T03:00:00.000Z',
      lastZtaSync: null,
      ztaStatus: 'not_licensed',
      lastError: null,
    });

    render(<MemoryRouter><CrowdStrikeTab /></MemoryRouter>);

    await waitFor(() =>
      expect(screen.getByText('Posture score requires Falcon Insight licensing')).toBeInTheDocument()
    );
    // The rest of the tab still renders — licensing must not break alerts/detection
    expect(screen.getAllByText('CrowdStrike Alerts').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('42').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Detection Rate')).toBeInTheDocument();
  });

  it('shows the no-data empty state when the ZTA endpoint fails but sync is licensed', async () => {
    mockCrowdstrikeApi.getZtaScore.mockRejectedValue(new Error('404'));
    mockCrowdstrikeApi.getZtaScoreTrend.mockResolvedValue([]);
    mockGetSyncStatus.mockResolvedValue({
      lastAlertSync: '2026-10-11T03:00:00.000Z',
      lastZtaSync: null,
      ztaStatus: 'ok',
      lastError: null,
    });

    render(<MemoryRouter><CrowdStrikeTab /></MemoryRouter>);

    await waitFor(() =>
      expect(screen.getByText(/No posture score data yet/)).toBeInTheDocument()
    );
    expect(screen.getAllByText('42').length).toBeGreaterThanOrEqual(1);
  });

  it('renders the sync error banner from the sync status', async () => {
    mockGetSyncStatus.mockResolvedValue({
      lastAlertSync: '2026-10-11T03:00:00.000Z',
      lastZtaSync: null,
      ztaStatus: 'ok',
      lastError: { stage: 'alerts', message: 'crowdstrike API 429: rate limited', at: '2026-10-11T03:00:00.000Z' },
    });

    render(<MemoryRouter><CrowdStrikeTab /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('CrowdStrike sync failed')).toBeInTheDocument());
    expect(screen.getByText(/rate limited/)).toBeInTheDocument();
  });
});
