// Mirrors backend/src/api/__tests__/crowdstrike-analytics.routes.test.ts.
// Fork difference: isCrowdStrikeConfigured is async (Blob-backed settings).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: any, _res: any, next: any) => next(),
  requireAuth: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../middleware/clerk.middleware.js', () => ({
  clerkAuth: (_req: any, _res: any, next: any) => next(),
  requireClerkAuth: () => (req: any, _res: any, next: any) => {
    req.auth = { userId: 'test-user-001' };
    next();
  },
  getUserId: (auth: any) => auth?.userId || 'test-user-001',
  getUserOrgId: () => undefined,
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  validateRequestOrgId: () => {},
}));

vi.mock('../../services/integrations/settings.js', () => ({
  IntegrationsSettingsService: class MockIntegrationsSettingsService {
    isCrowdStrikeConfigured = async () => true;
  },
}));

const mockGetAlerts = vi.fn();
const mockGetAlertSummary = vi.fn();
vi.mock('../../services/crowdstrike/analytics.service.js', () => ({
  CrowdStrikeAnalyticsService: class MockCrowdStrikeAnalyticsService {
    getAlerts = mockGetAlerts;
    getAlertSummary = mockGetAlertSummary;
  },
}));

const { default: crowdstrikeRoutes } = await import('../crowdstrike.routes.js');
const { errorHandler } = await import('../../middleware/error.middleware.js');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/analytics/crowdstrike', crowdstrikeRoutes);
  app.use(errorHandler);
  return app;
}

describe('CrowdStrike analytics routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAlerts.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 25 });
    mockGetAlertSummary.mockResolvedValue({ total: 0 });
  });

  describe('GET /alerts', () => {
    it('returns 400 Invalid from/to for an unparsable window', async () => {
      const res = await request(createApp()).get('/api/analytics/crowdstrike/alerts?from=bad&to=2026-10-20T00:00:00Z');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'Invalid from/to' });
      expect(mockGetAlerts).not.toHaveBeenCalled();
    });

    it('returns 400 Invalid from/to when only from is given', async () => {
      const res = await request(createApp()).get('/api/analytics/crowdstrike/alerts?from=bad');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'Invalid from/to' });
    });

    it('passes source, a comma severity list and the window to the service', async () => {
      const res = await request(createApp()).get(
        '/api/analytics/crowdstrike/alerts?source=test&severity=high,critical'
          + '&from=2026-10-01T00:00:00.000Z&to=2026-10-20T00:00:00.000Z',
      );

      expect(res.status).toBe(200);
      expect(mockGetAlerts).toHaveBeenCalledWith(expect.objectContaining({
        source: 'test',
        severities: ['high', 'critical'],
        window: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-20T00:00:00.000Z' },
      }));
    });

    it('keeps a single severity working', async () => {
      await request(createApp()).get('/api/analytics/crowdstrike/alerts?severity=high');

      expect(mockGetAlerts).toHaveBeenCalledWith(expect.objectContaining({ severities: ['high'] }));
    });

    it('sends no source, severities or window when none are given', async () => {
      await request(createApp()).get('/api/analytics/crowdstrike/alerts?page=2');

      const params = mockGetAlerts.mock.calls[0][0];
      expect(params.page).toBe(2);
      expect(params.source).toBeUndefined();
      expect(params.severities).toBeUndefined();
      expect(params.window).toBeNull();
    });

    it('returns 400 for an unknown source', async () => {
      const res = await request(createApp()).get('/api/analytics/crowdstrike/alerts?source=bogus');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'Invalid source' });
    });
  });

  describe('GET /alerts/summary', () => {
    it('passes the window to the service', async () => {
      const res = await request(createApp()).get(
        '/api/analytics/crowdstrike/alerts/summary?from=2026-10-01T00:00:00.000Z&to=2026-10-20T00:00:00.000Z',
      );

      expect(res.status).toBe(200);
      expect(mockGetAlertSummary).toHaveBeenCalledWith({
        from: '2026-10-01T00:00:00.000Z', to: '2026-10-20T00:00:00.000Z',
      });
    });

    it('passes a null window when from/to are absent', async () => {
      await request(createApp()).get('/api/analytics/crowdstrike/alerts/summary');

      expect(mockGetAlertSummary).toHaveBeenCalledWith(null);
    });

    it('returns 400 Invalid from/to when from >= to', async () => {
      const res = await request(createApp()).get(
        '/api/analytics/crowdstrike/alerts/summary?from=2026-10-20T00:00:00.000Z&to=2026-10-01T00:00:00.000Z',
      );

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'Invalid from/to' });
    });
  });
});
