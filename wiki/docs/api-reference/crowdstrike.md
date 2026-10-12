---
sidebar_position: 8
title: "CrowdStrike Endpoints"
description: "REST API endpoints for the CrowdStrike Falcon integration — ZTA posture score, alerts, cross-correlation, and auto-resolve."
---

# CrowdStrike Endpoints

All CrowdStrike endpoints require Clerk authentication. Analytics endpoints
require the `analytics:dashboards:read` permission; integration endpoints
require `integrations:read` or `integrations:write`.

All analytics endpoints are guarded by `requireCrowdStrikeConfigured()` and
return `400` when the integration is not configured.

## Analytics Endpoints

Base path: `/api/analytics/crowdstrike`

### ZTA Posture Score

```
GET /api/analytics/crowdstrike/zta-score
GET /api/analytics/crowdstrike/zta-score/trend
```

Current Zero Trust Assessment posture score (average `assessment.overall`,
0–100, with OS / sensor-config sub-scores and device spread), and its daily
snapshot history over time.

ZTA requires **Falcon Insight** licensing and the
`Zero Trust Assessment: read` scope. When unlicensed, the score endpoints
return the not-licensed state rather than an error — the rest of the
integration is unaffected.

| Query param (`/trend`) | Default | Description |
|------------------------|---------|-------------|
| `days` | 30 | Number of daily snapshots to return |

### Alerts

```
GET /api/analytics/crowdstrike/alerts/summary
GET /api/analytics/crowdstrike/alerts
GET /api/analytics/crowdstrike/alerts/trend
```

- **`/alerts/summary`** — alert counts broken down by severity
  (`informational` / `low` / `medium` / `high` / `critical`) and status
  (`new` / `in_progress` / `reopened` / `closed`).
- **`/alerts`** — the alert list, paged and filterable by severity, status,
  free-text search, and MITRE techniques.
- **`/alerts/trend`** — alert volume bucketed over time (`?days=<n>`).

### Cross-Correlation

```
GET /api/analytics/crowdstrike/correlation/scores
GET /api/analytics/crowdstrike/correlation/techniques
GET /api/analytics/crowdstrike/correlation/detection-rate
GET /api/analytics/crowdstrike/correlation/alerts-for-test
```

- **`/correlation/scores`** — Defense Score vs. ZTA posture score over time
  (`?days=<n>`).
- **`/correlation/techniques`** — MITRE technique overlap between test results
  and CrowdStrike alerts.
- **`/correlation/detection-rate`** — the headline **per-execution detection
  rate** (see below).
- **`/correlation/alerts-for-test`** — per-test evidence correlation; returns
  the CrowdStrike alerts matched to a specific test execution, with stage and
  bundle attribution (powers the alert drawer drill-down).

#### Detection Rate

```
GET /api/analytics/crowdstrike/correlation/detection-rate?days=<n>&windowMinutes=<n>
```

| Query param | Default | Description |
|-------------|---------|-------------|
| `days` | 30 | Look-back window for executions and alerts |
| `windowMinutes` | 60 | Correlation window — an execution is correlated if an alert for its technique falls within ±`windowMinutes` |

**Response:**

```jsonc
{
  "overall": {
    "detectionRate": 23.1,        // per-execution %, the headline metric
    "totalExecutions": 87,
    "correlatedExecutions": 20,
    "testedTechniques": 13,       // drill-down context
    "detectedTechniques": 3
  },
  "byTechnique": [
    { "technique": "T1574.002", "testExecutions": 5, "correlatedExecutions": 5, "detected": true }
  ]
}
```

See [Analytics → CrowdStrike Falcon](../user-guide/analytics/crowdstrike#detection-rate)
for the full metric definition.

## Integration Endpoints

Base path: `/api/integrations/crowdstrike`

### Configuration

```
GET    /api/integrations/crowdstrike
POST   /api/integrations/crowdstrike
DELETE /api/integrations/crowdstrike
POST   /api/integrations/crowdstrike/test
```

- **`GET /crowdstrike`** — returns whether CrowdStrike is configured, with
  secrets masked (`integrations:read`). The response includes the selected
  `region` plus a server-derived, display-only `base_url` resolved from that
  region.
- **`POST /crowdstrike`** — save credentials. Stored AES-256-GCM encrypted.
  Kicks off a background sync after saving (`integrations:write`).
- **`DELETE /crowdstrike`** — remove the stored configuration
  (`integrations:write`).
- **`POST /crowdstrike/test`** — validate credentials against the Falcon API
  (real token acquisition plus a `limit:1` alerts query).

**`POST /crowdstrike` body:**
```json
{
  "region": "us-1",
  "clientId": "...",
  "clientSecret": "...",
  "label": "Production Falcon"
}
```

`region` must be one of `us-1` (default), `us-2`, `eu-1`, or `us-gov-1` —
custom base URLs are not accepted; the API base URL is derived server-side
from the region. See
[Integrations → CrowdStrike Falcon](../user-guide/integrations/crowdstrike#cloud-regions).

### Sync

```
POST /api/integrations/crowdstrike/sync
GET  /api/integrations/crowdstrike/sync/status
```

- **`POST /crowdstrike/sync`** — trigger an immediate sync from the Falcon API
  (alerts + ZTA, followed by enrichment and an auto-resolve pass).
- **`GET /crowdstrike/sync/status`** — last sync timestamps for alerts and
  ZTA, plus `zta_status` (`ok` / `not_licensed`).

### Auto-Resolve

```
GET /api/integrations/crowdstrike/auto-resolve/status
PUT /api/integrations/crowdstrike/auto-resolve/mode
GET /api/integrations/crowdstrike/auto-resolve/receipts?limit=<n>&offset=<n>
```

- **`/auto-resolve/status`** — current mode plus recent receipt counts.
- **`/auto-resolve/mode`** — set the mode; body
  `{ "mode": "disabled" | "dry_run" | "enabled" }`.
- **`/auto-resolve/receipts`** — paginated receipt history.

See [CrowdStrike Auto-Resolve](../user-guide/integrations/crowdstrike-auto-resolve)
for the feature walkthrough.
