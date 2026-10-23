import { Router } from 'express';
import type { Request } from 'express';
import {
  requireClerkAuth,
  requirePermission,
  getUserId,
  getUserOrgId,
  validateRequestOrgId,
} from '../middleware/clerk.middleware.js';
import { asyncHandler, AppError } from '../middleware/error.middleware.js';
import { validate } from '../middleware/validation.js';
import {
  createCampaign,
  updateCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
} from '../services/campaigns/campaigns.service.js';
import { preflightCampaign } from '../services/campaigns/preflight.js';
import { launchRun, PartialRunError } from '../services/campaigns/runs.service.js';
import { getRunMatrix, listRuns, runMatrixCsv } from '../services/campaigns/matrix.js';
import {
  CreateCampaignSchema,
  UpdateCampaignSchema,
  RunCampaignSchema,
} from '../schemas/campaigns.schemas.js';

const router = Router();

router.use(requireClerkAuth());

/**
 * The caller's Clerk org, or undefined in legacy single-org mode. A no-org
 * caller is rejected when REQUIRE_ORG_ISOLATION=true (same rule as notices).
 */
function callerOrg(req: Request): string | undefined {
  const orgId = getUserOrgId(req.auth);
  if (orgId) return orgId;
  if (process.env.REQUIRE_ORG_ISOLATION === 'true') {
    throw new AppError('Organization isolation required. Configure Clerk Organizations.', 403);
  }
  return undefined;
}

function requireUser(req: Request): string {
  const userId = getUserId(req.auth);
  if (!userId) throw new AppError('Unable to determine user identity', 401);
  return userId;
}

const READ = 'endpoints:tasks:read';
const WRITE = 'endpoints:tasks:create';

router.get('/', requirePermission(READ), asyncHandler(async (req, res) => {
  res.json({ success: true, data: listCampaigns(callerOrg(req)) });
}));

// Run routes first: `/runs/:runId` must not be captured by `/:id`.
router.get('/runs/:runId', requirePermission(READ), asyncHandler(async (req, res) => {
  res.json({ success: true, data: getRunMatrix(req.params.runId, callerOrg(req)) });
}));

router.get('/runs/:runId/export.csv', requirePermission(READ), asyncHandler(async (req, res) => {
  const matrix = getRunMatrix(req.params.runId, callerOrg(req));
  // "As of" is the evidence snapshot time (spec 6.5.4): compact form for the filename.
  const compact = matrix.as_of.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace(/^(\d{8}T\d{4})\d{2}Z$/, '$1Z');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="campaign-run-${matrix.run.id}-${compact}.csv"`);
  res.setHeader('X-Report-As-Of', matrix.as_of);
  res.send(runMatrixCsv(matrix));
}));

router.post('/', requirePermission(WRITE), validate(CreateCampaignSchema), asyncHandler(async (req, res) => {
  const userId = requireUser(req);
  callerOrg(req);
  const { org_id, ...input } = req.body;
  validateRequestOrgId(org_id, req.auth);
  res.status(201).json({ success: true, data: createCampaign(input, org_id, userId) });
}));

router.get('/:id', requirePermission(READ), asyncHandler(async (req, res) => {
  res.json({ success: true, data: getCampaign(req.params.id, callerOrg(req)) });
}));

router.put('/:id', requirePermission(WRITE), validate(UpdateCampaignSchema), asyncHandler(async (req, res) => {
  const org = callerOrg(req);
  const { org_id: _ignored, ...input } = req.body;
  res.json({ success: true, data: updateCampaign(req.params.id, input, org) });
}));

router.delete('/:id', requirePermission(WRITE), asyncHandler(async (req, res) => {
  deleteCampaign(req.params.id, callerOrg(req));
  res.json({ success: true });
}));

router.get('/:id/preflight', requirePermission(READ), asyncHandler(async (req, res) => {
  const campaign = getCampaign(req.params.id, callerOrg(req));
  res.json({ success: true, data: preflightCampaign(campaign) });
}));

router.get('/:id/runs', requirePermission(READ), asyncHandler(async (req, res) => {
  const org = callerOrg(req);
  getCampaign(req.params.id, org); // 404 for unknown / cross-org, not an empty list
  res.json({ success: true, data: listRuns(req.params.id, org) });
}));

router.post('/:id/runs', requirePermission(WRITE), validate(RunCampaignSchema), asyncHandler(async (req, res) => {
  const userId = requireUser(req);
  const org = callerOrg(req);
  const { org_id, confirm_partial } = req.body;
  validateRequestOrgId(org_id, req.auth);
  try {
    const data = launchRun(req.params.id, {
      callerOrg: org,
      orgId: org_id,
      userId,
      confirmPartial: confirm_partial === true,
    });
    res.status(201).json({ success: true, data });
  } catch (err) {
    if (err instanceof PartialRunError) {
      res.status(409).json({ success: false, error: err.message, skipped: err.skipped });
      return;
    }
    throw err;
  }
}));

export default router;
