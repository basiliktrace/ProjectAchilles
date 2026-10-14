import { Router } from 'express';
import { requireClerkAuth, requirePermission, getUserOrgId, validateRequestOrgId, hasRequestPermission } from '../middleware/clerk.middleware.js';
import { asyncHandler, AppError } from '../middleware/error.middleware.js';
import { SettingsService } from '../services/analytics/settings.js';
import { IntegrationsSettingsService } from '../services/integrations/settings.js';
import { ExecutionReportService } from '../services/reports/executionReport.service.js';
import { SbReportService, parseSbReportWindow } from '../services/reports/sbReport.service.js';

const router = Router();

// Protect all report routes with Clerk authentication
router.use(requireClerkAuth());

const settingsService = new SettingsService();

// GET /api/reports/sb-pc-2026-001 - SB-PC-2026-001 compliance report (LockBit 3.0 bundle)
// Query params: from, to (ISO dates, required), org (UUID), org_code (SB entity
// code for meta.organization), bundle_uuid (f0rtika.bundle_id filter), vendor,
// plus optional analytics scope filters: tags, hostnames, tests, bundle_names
// (comma-separated, OR semantics — same fields as the analytics filter bar).
router.get('/sb-pc-2026-001', requirePermission('analytics:dashboards:read'), asyncHandler(async (req, res) => {
  const settings = await settingsService.getSettings();
  if (!settings.configured) {
    throw new AppError('Elasticsearch not configured', 400);
  }

  const { from, to } = parseSbReportWindow(req.query.from, req.query.to);

  // Org scoping: explicit ?org= wins, otherwise fall back to the JWT org claim.
  const org = (req.query.org as string | undefined) || getUserOrgId(req.auth);
  if (org) validateRequestOrgId(org, req.auth);

  const service = new SbReportService(settings);
  const report = await service.generateSbReport({
    from,
    to,
    org,
    orgCode: req.query.org_code as string | undefined,
    vendor: req.query.vendor as string | undefined,
    bundleUuid: req.query.bundle_uuid as string | undefined,
    tags: req.query.tags as string | undefined,
    hostnames: req.query.hostnames as string | undefined,
    tests: req.query.tests as string | undefined,
    bundleNames: req.query.bundle_names as string | undefined,
  });

  res.json(report);
}));

const RESULT_FILTERS = ['all', 'protected', 'unprotected', 'inconclusive'] as const;
type ResultFilter = (typeof RESULT_FILTERS)[number];

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

// GET /api/reports/executions - Print-ready execution report payload.
// Query params: the All executions filter-bar params (org, from, to, result,
// hostnames, tests, techniques, categories, severities, threatActors, tags,
// errorNames, errorCodes, bundleNames) plus tz (IANA zone, default UTC).
// org is never defaulted from the JWT (same as the analytics routes): ES
// routing.oid holds agent-org UUIDs, so a Clerk org id could filter to zero docs.
// Accepted risks are included only for callers with analytics:risk:read.
router.get('/executions', requirePermission('analytics:dashboards:read'), asyncHandler(async (req, res) => {
  const settings = await settingsService.getSettings();
  if (!settings.configured) {
    throw new AppError('Elasticsearch not configured', 400);
  }

  const q = req.query;
  const result = queryString(q.result);
  if (result && !(RESULT_FILTERS as readonly string[]).includes(result)) {
    throw new AppError(`Invalid result filter: ${result}`, 400);
  }

  const org = queryString(q.org);
  if (org) validateRequestOrgId(org, req.auth);

  const integrations = new IntegrationsSettingsService();
  const service = new ExecutionReportService(settings, {
    vendors: {
      defender: await integrations.isDefenderConfigured(),
      crowdstrike: await integrations.isCrowdStrikeConfigured(),
    },
  });

  const report = await service.generate({
    org,
    from: queryString(q.from),
    to: queryString(q.to),
    result: result as ResultFilter | undefined,
    hostnames: queryString(q.hostnames),
    tests: queryString(q.tests),
    techniques: queryString(q.techniques),
    categories: queryString(q.categories),
    severities: queryString(q.severities),
    threatActors: queryString(q.threatActors),
    tags: queryString(q.tags),
    errorNames: queryString(q.errorNames),
    errorCodes: queryString(q.errorCodes),
    bundleNames: queryString(q.bundleNames),
    tz: queryString(q.tz) ?? 'UTC',
    includeAcceptedRisks: hasRequestPermission(req, 'analytics:risk:read'),
    // Acceptances are scoped by the caller's Clerk org (as the risk-acceptance routes do), not the ES agent-org filter.
    acceptanceOrg: getUserOrgId(req.auth),
  });

  res.json({ success: true, data: report });
}));

export default router;
