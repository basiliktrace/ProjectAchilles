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

Settings and status for [pre-execution notices](../user-guide/integrations/pre-execution-notices). All routes need Clerk authentication. Settings and the notice log are per organization: the caller's Clerk organization is used, and an organization without its own settings falls back to the deployment-wide (legacy) settings. A notice belongs to the organization of the tasks it gates. `GET /api/notices`, `GET /api/notices/status` and `POST /api/notices/:id/release` only see the caller's organization's notices; another organization's notice id returns `404 Notice not found`. A caller without an organization (single-organization deployments) sees every notice, unless `REQUIRE_ORG_ISOLATION=true`, which returns `403` from every notice route, including the settings routes. These routes are not available on the Vercel (serverless) backend.

| Method | Path | Permission | Purpose |
|--------|------|------------|---------|
| `GET` | `/api/notices/settings` | `integrations:read` | Current settings, plus `smtp_configured` |
| `PUT` | `/api/notices/settings` | `integrations:write` | Update settings. Returns 400 if you enable without SMTP configured or without a recipient |
| `POST` | `/api/notices/settings/test` | `integrations:write` | Send a sample notice to the recipients |
| `GET` | `/api/notices/status` | `endpoints:tasks:read` | Banner data: overdue pending notices, not-delivered count (7 days), last SMTP check |
| `GET` | `/api/notices?limit=&offset=` | `endpoints:tasks:read` | List notices, newest first (`limit` 1 to 100, default 25; `offset` 0 or more, default 0) |
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

The grouped task list response (`GET /api/agent/admin/tasks/grouped`) adds a `notices` map (notice id to `run_tag`, `state`, `last_error`, `release_at`, `pickup_deadline`) on each batch group whose tasks are linked to notices. For a caller in an organization, the map only lists that organization's notices.

`GET /api/notices/status` returns `smtpCheck` as `{ "ok": null, "at": null, "message": null }` while notices are disabled. `pendingOverdue` and `notDeliveredLast7d` are always counted.

### Several tests under one notice

```
POST /api/agent/admin/tasks/batch
```

Creates the tasks for several tests as one run, under **one** pre-execution notice (one email), instead of one notice per test. The test browser uses it when you run more than one test at once. Requires `endpoints:tasks:create`.

```json
{
  "org_id": "default",
  "requests": [
    { "agent_ids": ["agent-uuid-1"], "test_uuid": "test-uuid-a", "test_name": "Test A", "binary_name": "a.exe" },
    { "agent_ids": ["agent-uuid-1", "agent-uuid-2"], "test_uuid": "test-uuid-b", "test_name": "Test B", "binary_name": "b.exe" }
  ]
}
```

Each entry in `requests` takes the same fields as `POST /api/agent/admin/tasks`, without `org_id`. Send 1 to 50 requests. The batch is all-or-nothing: if any request fails (for example, a test has no build for an agent's OS), nothing is created and no notice is sent. The response is `201` with the task ids of each request, in request order:

```json
{ "success": true, "data": { "task_ids": [["task-1"], ["task-2", "task-3"]] } }
```

This route works whether or not notices are enabled.
