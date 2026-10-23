---
sidebar_position: 8
title: "Alerting Endpoints"
description: "REST API endpoints for configuring alert thresholds and notification channels."
---

# Alerting Endpoints

## Endpoints

### Get Alert Configuration

```
GET /api/integrations/alerts/config
```

Returns current alert thresholds and notification channel configuration.

### Save Alert Configuration

```
POST /api/integrations/alerts/config
```

**Body:**
```json
{
  "thresholds": {
    "relative_drop": 10,
    "absolute_floor": 50
  },
  "channels": {
    "slack": {
      "enabled": true,
      "webhook_url": "https://hooks.slack.com/services/..."
    },
    "email": {
      "enabled": true,
      "smtp_host": "smtp.gmail.com",
      "smtp_port": 587,
      "smtp_user": "alerts@example.com",
      "smtp_pass": "...",
      "recipients": ["team@example.com"]
    }
  }
}
```

Credentials are encrypted at rest with AES-256-GCM.

## Pre-execution notices

Settings and status for [pre-execution notices](../user-guide/integrations/pre-execution-notices). All routes need Clerk authentication. Settings are deployment-wide. These routes are not available on the Vercel (serverless) backend.

| Method | Path | Permission | Purpose |
|--------|------|------------|---------|
| `GET` | `/api/notices/settings` | `integrations:read` | Current settings, plus `smtp_configured` |
| `PUT` | `/api/notices/settings` | `integrations:write` | Update settings. Returns 400 if you enable without SMTP configured or without a recipient |
| `POST` | `/api/notices/settings/test` | `integrations:write` | Send a sample notice to the recipients |
| `GET` | `/api/notices/status` | `endpoints:tasks:read` | Banner data: overdue pending notices, not-delivered count (7 days), last SMTP check |
| `GET` | `/api/notices?limit=&offset=` | `endpoints:tasks:read` | List notices, newest first (`limit` 1 to 100, default 25) |
| `POST` | `/api/notices/:id/release` | `endpoints:tasks:create` | Release a pending notice without delivery. Body: `{ "reason": "..." }` (required). Returns 400 if the notice is no longer pending |

**Settings body (`PUT /api/notices/settings`):** all fields are optional.

```json
{
  "enabled": true,
  "recipients": ["secops@example.com"],
  "lead_minutes": 5,
  "max_wait_minutes": 60,
  "pickup_window_minutes": 120,
  "send_finished": true
}
```

`lead_minutes` is clamped to 0 to 5, `max_wait_minutes` to 15 to 1440, and `pickup_window_minutes` to 30 to 1440. Recipients must be bare email addresses.

**Test notice response (`POST /api/notices/settings/test`):**

```json
{
  "success": true,
  "data": {
    "accepted": ["secops@example.com"],
    "rejected": [],
    "fully_accepted": true
  }
}
```

The grouped task list response adds a `notices` map (notice id to `run_tag`, `state`, `last_error`, `release_at`, `pickup_deadline`) on each batch group whose tasks are linked to notices.
