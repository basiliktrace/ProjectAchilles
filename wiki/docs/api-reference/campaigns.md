---
sidebar_position: 8
title: "Campaigns Endpoints"
description: "REST API endpoints for saved test campaigns, runs, and evidence export."
---

# Campaigns Endpoints

Base path: `/api/campaigns`. All routes require Clerk authentication. Reads need
`endpoints:tasks:read`; create, update, delete and run need `endpoints:tasks:create`.

Campaigns are served by the Express backend only. `GET /api/capabilities`
reports `campaigns: true` there and `campaigns: false` on the Vercel
(serverless) backend, which does not mount these routes.

## Organization scoping

- Reads filter by the caller's Clerk organization. A campaign or run in another
  organization returns `404` (`Campaign not found` / `Campaign run not found`).
- With `REQUIRE_ORG_ISOLATION=true`, a caller with no organization gets `403`
  on **every** route.
- A campaign's organization is fixed at creation. On create and run, `org_id` in
  the body must match the caller's organization or the call returns `403`. On
  run, `org_id` must also equal the campaign's own organization (`403` if not);
  the run always uses the campaign's organization. `org_id` is ignored on update.

## Campaigns

```
GET    /api/campaigns
POST   /api/campaigns
GET    /api/campaigns/:id
PUT    /api/campaigns/:id
DELETE /api/campaigns/:id
```

Create / update body:

```json
{
  "org_id": "org_XXX",
  "name": "Q4 ransomware validation",
  "description": "optional, max 2000 chars",
  "framework_label": "optional, max 120 chars",
  "test_uuids": ["<test-uuid>"],
  "agent_ids": ["<agent-id>"]
}
```

Rules, each failing with `400` unless noted:

| Rule | Error |
|------|-------|
| `name` 1-120 characters | validation error |
| Name unique per org | `409 A campaign with this name already exists` |
| 1-100 tests, at least 1 agent | `A campaign can have at most 100 tests` / `needs at least 1 ...` |
| Each test exists in the catalog | `Unknown test <uuid>` |
| Each agent exists and is in the caller's org | `Agent <id> does not belong to your organization` |

Duplicate ids are removed. Deleting a campaign does not delete its runs.

## Preflight

```
GET /api/campaigns/:id/preflight
```

Dry run. Returns the dispatchable `dispatch` groups, the `skipped` pairs
(`{ test_uuid, agent_id, reason }`), `task_count`, and the `tests` and `agents`
involved. Skip reasons: `not built`, `no <os> binary`, `binary missing on
server`, `agent <status>`, `agent deleted`, `agent not in organization`,
`removed from library`. It writes nothing.

## Runs

```
POST /api/campaigns/:id/runs
GET  /api/campaigns/:id/runs
GET  /api/campaigns/runs
GET  /api/campaigns/runs/:runId
GET  /api/campaigns/runs/:runId/export.csv
```

### Start a run

```json
{ "org_id": "org_XXX", "confirm_partial": false }
```

Success (`201`): `{ "success": true, "data": { "run_id", "task_count", "skipped" } }`. Here `skipped` is a **count**; in the `409` body below it is an **array** of pairs.

| Status | When |
|--------|------|
| `409` | Some pairs are skipped and `confirm_partial` is not `true`. The body is `{ "success": false, "error": "...", "skipped": [...] }`. Repeat with `confirm_partial: true` to run the rest. |
| `400` | Nothing to run (every pair skipped); more than 5,000 tasks (`Run would create N tasks (max 5000)`); an agent was deleted or now belongs to another organization (`Agent <id> does not belong to your organization`) |
| `403` | `org_id` does not match the campaign's or the caller's organization |

The run row, every task, and the pre-execution notice (when notices are
enabled; one per run) are written in a single transaction.

### List runs

`GET /api/campaigns/:id/runs` lists the runs of one campaign (`404` for an
unknown or cross-org campaign). `GET /api/campaigns/runs` lists every run in the
caller's org, including runs of deleted campaigns. Both are newest first and
paged:

| Query | Default | Range |
|-------|---------|-------|
| `limit` | `25` | clamped to `1`..`100` |
| `offset` | `0` | clamped to `>= 0` |

A value that is not a number falls back to the default. The response is
`{ "success": true, "data": { "items": [...], "total": N } }`, where `total` is
the number of runs before paging.

Each item has `id`, `started_at`, `started_by` (Clerk user id),
`started_by_name`, `task_count` and `percent_protected`. Items of
`GET /api/campaigns/runs` also have `campaign_id`, `campaign_name` (from the run
snapshot) and `campaign_deleted` (`true` when the campaign no longer exists).

`started_by_name` is captured at launch from the Clerk session claims (`name`,
`full_name`, `email` or `primary_email`, the first one present) and stored in
the run snapshot. When the session carried none, it is the user id; runs
started before the field existed also report the user id.

### Run matrix

`GET /api/campaigns/runs/:runId` returns:

- `run`: id, campaign id and name, framework label, `started_by`, `started_by_name`, `started_at`, and `notice` (or `null` when notices were off at launch)
- `run.notice`: `id`, `run_tag`, `state`, `last_error`, `release_at`, `pickup_deadline`, plus the delivery record `sent_at`, `recipients` (array of addresses), `override_by`, `override_reason` and `override_at`
- `tests`, `agents`: the snapshot taken at launch
- `cells[test_uuid][agent_id]`: `{ state, exit_code, task_id, completed_at, reason, techniques }`. `reason` is the skip reason for `na`, the task's error for `not_run` and `error`, otherwise `null`
- `totals`: a count per state plus `percent_protected`
- `as_of`: ISO time the evidence was read

Cell `state` is one of `waiting_for_notice`, `running`, `protected`,
`unprotected`, `error`, `not_run`, `na`. `percent_protected` is
`protected / (protected + unprotected)` rounded to an integer, or `null` when
the denominator is 0. A cell reflects the latest task of the test and agent pair
in the run (retries inherit the run id).

### CSV export

`GET /api/campaigns/runs/:runId/export.csv` returns `text/csv` with exactly this
header:

```
test,techniques,host,os,outcome,exit_code,reason,completed_at,as_of
```

There is one row for every test and host pair in the snapshot; none are left out.

| Column | Content |
|--------|---------|
| `outcome` | The cell state. A pair skipped at launch is `na` |
| `exit_code` | The latest attempt's exit code; empty for `na` and `not_run` |
| `reason` | Skip reason (`na`), expiry or cancel reason (`not_run`), agent error (`error`); otherwise empty |
| `techniques` | ATT&CK techniques of the latest attempt, `; `-separated |
| `as_of` | The time the evidence was read (the same on every row) |

Rows are CRLF-terminated, and cells that start with `=`, `+`, `-`, `@`, a tab or a carriage return are
prefixed with `'` so spreadsheets don't evaluate them. The
`Content-Disposition` filename carries the as-of time
(`campaign-run-<run-id>-20261023T1405Z.csv`) and the `X-Report-As-Of` header
carries the full ISO time.
