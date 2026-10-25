---
sidebar_position: 7
title: "SentinelOne"
description: "Configure the SentinelOne integration: continuous alert extraction (read-only) with opt-in auto-resolve and automatic mitigation."
---

# SentinelOne

The SentinelOne integration continuously pulls **threats** (`GET /web/api/v2.1/threats`)
and **detection alerts** (`GET /web/api/v2.1/cloud-detection/alerts`) from a
SentinelOne management console into the `achilles-sentinelone` Elasticsearch
index, using the same alert document shape as the Defender and CrowdStrike
integrations (`alert_id`, `alert_title`, `severity`, `status`,
`mitre_techniques`, `evidence_hostnames`, `evidence_filenames`, …) so the rest
of the platform can consume it.

## Configure

**Settings → Integrations → SentinelOne**

| Field | Description |
|-------|-------------|
| Console URL | `https://<tenant>.sentinelone.net` (or `*.s1gov.net`). Other hosts are rejected. |
| API Token | Service-user API token. Stored AES-256-GCM encrypted, never returned or logged. Sent as `Authorization: ApiToken <token>`. |
| Permission mode | **Read-only** (default) or **Response** — see below. |
| Polling interval | Minutes between syncs (1–1440, default 5). |
| Initial backfill | Days of history pulled on the first sync (1–365, default 365 — the console's alert retention). |
| Data sources | Threats and/or detection alerts. |
| Segmentation | Optional Account / Site / Group IDs (sent as API scope filters), severities and incident statuses (applied before indexing). |

**Test Connection** performs an authenticated read (`GET /threats?limit=1&countOnly=true`)
within the configured scope.

Environment variables `SENTINELONE_BASE_URL`, `SENTINELONE_API_TOKEN`,
`SENTINELONE_PERMISSION_MODE` (`read_only`|`response`) and `SENTINELONE_LABEL`
can be used instead of the UI; UI settings take priority.

## Sync behavior

- First run: backfills the configured window (`createdAt__gte`).
- Afterwards: incremental from a persisted checkpoint (threats by `updatedAt__gte`,
  so status/mitigation changes re-sync; alerts by `createdAt__gte`), with a
  2-minute overlap. Pagination follows `pagination.nextCursor`.
- Documents are upserted by SentinelOne id (`threat-<id>`, `alert-<alertId>`), so
  re-fetches never duplicate.
- A checkpoint only advances when the run had no errors. Changing the console
  URL or scope resets checkpoints; **Re-backfill** does so on demand.

## Permission modes

| Mode | Allowed |
|------|---------|
| Read-only | GET extraction only. The API client itself refuses any non-GET request. |
| Response | Read-only + the writes of the two opt-in passes: incident status / notes for **auto-resolve**, and `POST /threats/mitigate/{kill,quarantine}` for **automatic mitigation**. Both stay off until you enable them. |

There are no manual response actions (kill, quarantine, network isolation by
id) in this release. Every automatic-mitigation attempt (success, rejected,
failed) is recorded as a `doc_type: response_action` document in
`achilles-sentinelone` and shown under **Mitigation audit**.

Required SentinelOne roles: **Viewer** for read-only; a role allowing incident
status changes and threat mitigation (e.g. IR Team / SOC) for Response mode.

## API

All routes require Clerk auth; reads need `integrations:read`, writes `integrations:write`.

| Method | Path | Purpose |
|--------|------|---------|
| GET/POST/DELETE | `/api/integrations/sentinelone` | Masked settings / save (partial) / disconnect |
| POST | `/api/integrations/sentinelone/test` | Connection test |
| POST | `/api/integrations/sentinelone/sync` | Start a manual sync in the background (`{ "reset": true }` re-backfills). Returns **202** `{ started, inProgress }`; poll `/sync/status`. While a sync runs, nothing new starts (`started: false`). |
| GET | `/api/integrations/sentinelone/sync/status` | Checkpoints, last result, last error |
| GET | `/api/integrations/sentinelone/alerts` | Ingested alerts (`limit`, `offset`, `severity`, `source`) |
| GET | `/api/integrations/sentinelone/actions/history` | Automatic-mitigation audit trail |
