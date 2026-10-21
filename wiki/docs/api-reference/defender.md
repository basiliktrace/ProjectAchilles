---
sidebar_position: 7
title: "Defender Endpoints"
description: "REST API endpoints for the Microsoft Defender integration — Secure Score, alerts, control profiles, cross-correlation, and auto-resolve."
---

# Defender Endpoints

All Defender endpoints require Clerk authentication. Analytics endpoints require
the `analytics:dashboards:read` permission; integration endpoints require
`integrations:read` or `integrations:write`.

## Analytics Endpoints

Base path: `/api/analytics/defender`

### Secure Score

```
GET /api/analytics/defender/secure-score
GET /api/analytics/defender/secure-score/trend
```

Current Microsoft Secure Score with category breakdown, and its history over
time.

### Alerts

```
GET /api/analytics/defender/alerts/summary
GET /api/analytics/defender/alerts
GET /api/analytics/defender/alerts/trend
```

- **`/alerts/summary`** — alert counts broken down by severity and status.
- **`/alerts`** — the alert list, filterable by severity and time range.
- **`/alerts/trend`** — alert volume bucketed over time.

### Controls

```
GET /api/analytics/defender/controls
GET /api/analytics/defender/controls/by-category
GET /api/analytics/defender/controls/correlation
```

- **`/controls`** — Defender control profiles with compliance status.
- **`/controls/by-category`** — controls grouped by category.
- **`/controls/correlation`** — controls linked to the alerts and techniques
  they cover (control ↔ alert linking).

### Window parameters

The alert, trend and coverage endpoints accept an optional ISO-8601 window,
which the Analytics tab fills from the header date picker.

| Query param | Description |
|-------------|-------------|
| `from` | Window start (ISO-8601). Must be sent together with `to`. |
| `to` | Window end (ISO-8601). |

When both are absent, the endpoints behave exactly as before (the CLI and the
drawers rely on this), except `technique-coverage`, which then defaults to the
last 30 days. An unparsable value, only one of the pair, or `from >= to` returns
`400 {"success": false, "error": "Invalid from/to"}`.

#### Alert feed filters

`GET /alerts` also accepts:

| Query param | Description |
|-------------|-------------|
| `source` | `all` (default), `test` (alerts linked to an Achilles test, `f0rtika.achilles_correlated: true`) or `organic` (everything else, including alerts with no correlation field). Anything else returns `400 Invalid source`. |
| `severity` | One severity or a comma-separated list, e.g. `high,critical`. |

The response carries a `counts` object (also returned by `/alerts/summary`)
that backs the feed's filter segments and summary strip:

```jsonc
{
  "data": [ /* alerts */ ],
  "total": 42, "page": 1, "pageSize": 25,
  "counts": {
    "bySource":   { "all": 120, "test": 31, "organic": 89 },   // every filter except source
    "bySeverity": { "high": 12, "medium": 40 },                 // every filter except severity
    "autoResolved": 7,   // alerts Achilles really resolved (mode enabled, no error)
    "linkedOpen": 4,
    "byProduct": { "Microsoft Defender for Endpoint": 30 }   // Defender only
  }
}
```

Because each facet ignores its own filter, the segment counts stay stable while
you click through them. `linkedOpen` is linked alerts that are not
closed/resolved, over the window only.

#### Trend

`GET /alerts/trend` with `from`/`to` ignores `days` and buckets by **day** when
the window is 90 days or shorter, otherwise by **week**. Every point carries:

| Field | Description |
|-------|-------------|
| `count` | Total alerts in the bucket |
| `linked` | Alerts linked to an Achilles test; `count - linked` is the organic remainder |
| `interval` | `day` or `week`, the bucket width of the series |

### Technique Coverage

```
GET /api/analytics/defender/correlation/technique-coverage?from=<iso>&to=<iso>
```

Evidence-based per-technique coverage. One response drives both the Detection
Rate tile and the Technique Coverage card, so they cannot disagree.

**Execution set.** Results documents with `routing.event_time` in the window,
excluding the attack-simulation exclusions (cyber-hygiene controls and skipped
bundle stages) and any result whose exit code is not in
`0, 1, 101, 105, 126, 127, 259, 999`. These are the same eligibility clauses
the enrichment pass uses.

**Evidence rule.** Per execution, detected is `f0rtika.defender_stage_detected`
when that field exists, otherwise `f0rtika.defender_detected`. A stage whose
own flag is `false` is never credited because a sibling stage was caught.
Prevented is the subset that is detected **and** `f0rtika.defender_prevented: true`;
detected-only is detected and not prevented; missed is the rest.

```jsonc
{
  "overall": {
    "executions": 87,          // distinct executions, not technique observations
    "prevented": 20,
    "detectedOnly": 12,
    "missed": 55,
    "detectionRate": 36.8,     // (prevented + detectedOnly) / executions, 1 dp
    "preventionRate": 23.0,    // prevented / executions, 1 dp
    "testedTechniques": 13,
    "detectedTechniques": 5
  },
  "byTechnique": [
    { "technique": "T1574.002", "name": "DLL Side-Loading", "executions": 5,
      "prevented": 3, "detectedOnly": 1, "missed": 1, "alerts": 6 }
  ]
}
```

`overall` counts distinct executions, while one execution that exercises
several techniques appears in each of their rows, so the rows can sum past the
totals. `byTechnique` lists detected techniques first, then by executions
descending. `alerts` is Defender alerts tagged with that **exact** technique id in
the window (no sub-technique roll-up).

:::note Not the same as /correlation/detection-rate
[`/correlation/detection-rate`](#detection-rate) (below) is the older technique plus time-window
heuristic and is kept for the CLI. The Analytics tab now uses
`technique-coverage`, so its numbers can differ from the heuristic.
:::

### Cross-Correlation

```
GET /api/analytics/defender/correlation/scores
GET /api/analytics/defender/correlation/techniques
GET /api/analytics/defender/correlation/detection-rate
GET /api/analytics/defender/correlation/technique-coverage
GET /api/analytics/defender/correlation/alerts-for-test
```

- **`/correlation/scores`** — Defense Score vs. Secure Score over time.
- **`/correlation/techniques`** — MITRE technique overlap between test results
  and Defender alerts.
- **`/correlation/detection-rate`** — the legacy technique plus time-window
  **per-execution detection rate** (see below), kept for the CLI.
- **`/correlation/technique-coverage`** — evidence-based coverage that drives
  the Analytics tab (see [Technique Coverage](#technique-coverage)).
- **`/correlation/alerts-for-test`** — per-test evidence correlation; returns
  the Defender alerts matched to a specific test execution (powers the alert
  drawer drill-down).

#### Detection Rate

```
GET /api/analytics/defender/correlation/detection-rate?days=<n>&windowMinutes=<n>
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

See [Analytics → Microsoft Defender](../user-guide/analytics/microsoft-defender#detection-rate)
for the full metric definition.

## Integration Endpoints

Base path: `/api/integrations/defender`

### Configuration

```
GET  /api/integrations/defender
POST /api/integrations/defender
POST /api/integrations/defender/test
```

- **`GET /defender`** — returns whether Defender is configured (no secrets).
- **`POST /defender`** — save credentials. Stored AES-256-GCM encrypted.
- **`POST /defender/test`** — validate credentials against Microsoft Graph.

**`POST /defender` body:**
```json
{
  "tenantId": "...",
  "clientId": "...",
  "clientSecret": "..."
}
```

### Sync

```
POST /api/integrations/defender/sync
GET  /api/integrations/defender/sync/status
```

- **`POST /defender/sync`** — trigger an immediate sync from Microsoft Graph.
- **`GET /defender/sync/status`** — last sync timestamps for scores and alerts.

### Auto-Resolve

```
GET /api/integrations/defender/auto-resolve/status
PUT /api/integrations/defender/auto-resolve/mode
GET /api/integrations/defender/auto-resolve/receipts?limit=<n>&offset=<n>
```

- **`/auto-resolve/status`** — current mode plus recent receipt counts.
- **`/auto-resolve/mode`** — set the mode; body `{ "mode": "disabled" | "dry_run" | "enabled" }`.
- **`/auto-resolve/receipts`** — paginated receipt history.

See [Defender Auto-Resolve](../user-guide/integrations/defender-auto-resolve)
for the feature walkthrough.
