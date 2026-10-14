import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockGetUserOrgId = vi.fn();
const mockValidateOrg = vi.fn();
const mockHasPermission = vi.fn();
vi.mock('../../middleware/clerk.middleware.js', () => ({
  requireClerkAuth: () => (req: any, _res: any, next: any) => { req.auth = { userId: 'u1' }; next(); },
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  getUserOrgId: (...a: unknown[]) => mockGetUserOrgId(...a),
  validateRequestOrgId: (...a: unknown[]) => mockValidateOrg(...a),
  hasRequestPermission: (...a: unknown[]) => mockHasPermission(...a),
}));

const mockGetSettings = vi.fn();
vi.mock('../../services/analytics/settings.js', () => ({
  SettingsService: class { getSettings = mockGetSettings; },
}));
vi.mock('../../services/integrations/settings.js', () => ({
  IntegrationsSettingsService: class { isDefenderConfigured = async () => true; isCrowdStrikeConfigured = async () => false; },
}));

const mockGenerate = vi.fn();
const constructed: unknown[][] = [];
vi.mock('../../services/reports/executionReport.service.js', () => ({
  ExecutionReportService: class {
    constructor(...args: unknown[]) { constructed.push(args); }
    generate = mockGenerate;
  },
}));
vi.mock('../../services/reports/sbReport.service.js', () => ({ SbReportService: class {}, parseSbReportWindow: vi.fn() }));

const { default: reportsRoutes } = await import('../reports.routes.js');
const { errorHandler, AppError } = await import('../../middleware/error.middleware.js');

function app() {
  const a = express();
  a.use('/api/reports', reportsRoutes);
  a.use(errorHandler);
  return a;
}

describe('GET /api/reports/executions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateOrg.mockReset(); // clearAllMocks keeps implementations: don't leak the 403 test's throw
    constructed.length = 0;
    mockGetSettings.mockResolvedValue({ configured: true, indexPattern: 'achilles-results-*' });
    // The JWT carries an org, but the report must not default to it: ES routing.oid
    // holds agent-org UUIDs, so only an explicit ?org= narrows the report (as in the console).
    mockGetUserOrgId.mockReturnValue('org-jwt');
    mockHasPermission.mockReturnValue(true);
    mockGenerate.mockResolvedValue({ meta: { reportId: 'RPT-1' } });
  });

  it('returns the report in the standard envelope', async () => {
    const res = await request(app()).get('/api/reports/executions?from=now-30d&hostnames=H1&result=unprotected');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { meta: { reportId: 'RPT-1' } } });
    expect(mockGenerate).toHaveBeenCalledWith(expect.objectContaining({
      from: 'now-30d', hostnames: 'H1', result: 'unprotected', tz: 'UTC', includeAcceptedRisks: true,
    }));
    expect(mockHasPermission).toHaveBeenCalledWith(expect.anything(), 'analytics:risk:read');
    expect(constructed[0][1]).toEqual({ vendors: { defender: true, crowdstrike: false } });
  });

  it('does not default the org to the JWT org', async () => {
    await request(app()).get('/api/reports/executions');
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockGenerate.mock.calls[0][0].org).toBeUndefined();
    expect(mockValidateOrg).not.toHaveBeenCalled();
  });

  it('validates an explicit org against the caller and passes it through with tz', async () => {
    await request(app()).get('/api/reports/executions?org=org-x&tz=America%2FSanto_Domingo');
    expect(mockValidateOrg).toHaveBeenCalledWith('org-x', { userId: 'u1' });
    expect(mockGenerate).toHaveBeenCalledWith(expect.objectContaining({ org: 'org-x', tz: 'America/Santo_Domingo' }));
  });

  it('omits accepted risks for callers without analytics:risk:read', async () => {
    mockHasPermission.mockReturnValue(false);
    await request(app()).get('/api/reports/executions');
    expect(mockGenerate).toHaveBeenCalledWith(expect.objectContaining({ includeAcceptedRisks: false }));
  });

  it('400s when Elasticsearch is not configured', async () => {
    mockGetSettings.mockResolvedValue({ configured: false });
    const res = await request(app()).get('/api/reports/executions');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('400s on an unknown result filter', async () => {
    const res = await request(app()).get('/api/reports/executions?result=maybe');
    expect(res.status).toBe(400);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('403s when the org does not match the caller', async () => {
    mockValidateOrg.mockImplementation(() => { throw new AppError('org_id does not match your organization', 403); });
    const res = await request(app()).get('/api/reports/executions?org=someone-else');
    expect(res.status).toBe(403);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('passes service errors through (e.g. 502)', async () => {
    mockGenerate.mockRejectedValue(new AppError('Report query failed: boom', 502));
    const res = await request(app()).get('/api/reports/executions');
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ success: false, error: 'Report query failed: boom' });
  });
});
