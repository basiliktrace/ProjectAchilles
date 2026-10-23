import { Router } from 'express';
import { requireClerkAuth, requirePermission, getUserId } from '../middleware/clerk.middleware.js';
import { asyncHandler, AppError } from '../middleware/error.middleware.js';
import { validate } from '../middleware/validation.js';
import { IntegrationsSettingsService } from '../services/integrations/settings.js';
import { sendMail } from '../services/alerts/email.service.js';
import { buildNoticeEmail } from '../services/notices/render.js';
import { isFullyAccepted } from '../services/notices/acceptance.js';
import {
  getNoticeStatus,
  listNotices,
  releaseWithoutNotice,
  tasksUiUrl,
} from '../services/notices/notices.service.js';
import { UpdateNoticeSettingsSchema, ReleaseNoticeSchema } from '../schemas/notices.schemas.js';

const router = Router();

router.use(requireClerkAuth());

// Notice settings are deployment-wide: never org-scoped.
const settingsService = () => new IntegrationsSettingsService();

const smtpConfigured = (svc: IntegrationsSettingsService): boolean =>
  !!svc.getAlertSettings()?.email?.configured;

router.get('/settings', requirePermission('integrations:read'), asyncHandler(async (_req, res) => {
  const svc = settingsService();
  res.json({
    success: true,
    data: { ...svc.getPreExecutionNoticeSettings(), smtp_configured: smtpConfigured(svc) },
  });
}));

router.put(
  '/settings',
  requirePermission('integrations:write'),
  validate(UpdateNoticeSettingsSchema),
  asyncHandler(async (req, res) => {
    const svc = settingsService();
    const current = svc.getPreExecutionNoticeSettings();
    const enabled = req.body.enabled ?? current.enabled;
    const recipients: string[] = req.body.recipients ?? current.recipients;

    if (enabled) {
      if (!smtpConfigured(svc)) {
        throw new AppError('SMTP email must be configured in Alerts before enabling notices', 400);
      }
      if (recipients.length === 0) {
        throw new AppError('At least one recipient is required', 400);
      }
    }

    const saved = svc.savePreExecutionNoticeSettings(req.body);
    res.json({ success: true, data: { ...saved, smtp_configured: smtpConfigured(svc) } });
  }),
);

router.post('/settings/test', requirePermission('integrations:write'), asyncHandler(async (_req, res) => {
  const svc = settingsService();
  const email = svc.getAlertSettings()?.email;
  if (!email?.configured) {
    throw new AppError('SMTP email must be configured in Alerts before sending a test notice', 400);
  }
  const recipients = svc.getPreExecutionNoticeSettings().recipients;
  if (recipients.length === 0) {
    throw new AppError('At least one recipient is required', 400);
  }

  const now = new Date();
  const built = buildNoticeEmail({
    kind: 'run',
    runTag: 'PA-RUN-TEST00',
    timezone: 'UTC',
    trigger: 'Test notice (no tests will run)',
    startNotBefore: now,
    pickupDeadline: new Date(now.getTime() + 2 * 3_600_000),
    windowEnd: new Date(now.getTime() + 3 * 3_600_000),
    tests: [{ name: 'Sample test', severity: 'medium', category: 'sample', techniques: ['T0000'], tactics: [] }],
    hosts: [{ hostname: 'sample-host', os: 'windows', online: true }],
    edr: [],
    uiUrl: tasksUiUrl(),
  });

  const result = await sendMail(email, { to: recipients, subject: `[TEST] ${built.subject}`, html: built.html });
  res.json({
    success: true,
    data: {
      accepted: result.accepted,
      rejected: result.rejected,
      fully_accepted: isFullyAccepted(recipients, result),
    },
  });
}));

router.get('/status', requirePermission('endpoints:tasks:read'), asyncHandler(async (_req, res) => {
  res.json({ success: true, data: getNoticeStatus() });
}));

router.get('/', requirePermission('endpoints:tasks:read'), asyncHandler(async (req, res) => {
  const rawLimit = parseInt(String(req.query.limit ?? ''), 10);
  const rawOffset = parseInt(String(req.query.offset ?? ''), 10);
  // SQLite treats a negative LIMIT as unlimited, so clamp explicitly.
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 25;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;
  res.json({ success: true, data: listNotices(limit, offset) });
}));

router.post(
  '/:id/release',
  requirePermission('endpoints:tasks:create'),
  validate(ReleaseNoticeSchema),
  asyncHandler(async (req, res) => {
    const userId = getUserId(req.auth);
    if (!userId) throw new AppError('Unable to determine user identity', 401);
    const notice = releaseWithoutNotice(req.params.id, userId, req.body.reason);
    res.json({ success: true, data: notice });
  }),
);

export default router;
