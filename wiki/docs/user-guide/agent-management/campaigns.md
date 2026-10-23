---
sidebar_position: 6
title: "Campaigns"
description: "Save a test plan of tests and agents, run it with one click, and export an evidence matrix."
---

# Campaigns

A **campaign** is a saved test plan: a set of tests crossed with a set of agents. You run it with one click, and ProjectAchilles produces an **evidence matrix** (one cell per test and host) that you can read on screen, export as CSV, or print.

Use campaigns when you need repeatable, auditable proof of what was tested and what the controls did, for example for a compliance review or a quarterly validation. A campaign is also optionally labelled with a **framework label** (for example `ISO 27001 A.8`) that is carried onto the evidence page.

:::info Availability
Campaigns are available on self-hosted deployments (Docker, Render, Fly.io, Railway, public and on-prem servers). They are not available on Vercel; the **Campaigns** menu entry is hidden when the deployment does not support them.
:::

## Creating a Campaign

1. Open **Campaigns** in the navigation
2. Click **New campaign**
3. Fill in:
   - **Name** (required, 1-120 characters, unique within your organization)
   - **Description** (optional, up to 2000 characters)
   - **Framework label** (optional, up to 120 characters)
   - **Tests** to include (1 to 100)
   - **Agents** to target (at least 1)
4. Save

Editing a campaign changes the plan for future runs only. Existing runs keep the plan they started with (see [Evidence snapshots](#evidence-snapshots)).

Every agent you pick must belong to your organization, and every test must exist in the test library.

## Running a Campaign

Click **Run** on a campaign. A dialog first checks the plan against the current state of the library and fleet and shows how many tasks will be created.

### Skipped pairs

Some test and host pairs cannot run. They are listed in the dialog with the reason:

| Reason | Meaning |
|--------|---------|
| `not built` | The test has never been built |
| `no <os> binary` | The test has no build for the host's operating system |
| `binary missing on server` | The build is recorded but the file is gone from the server |
| `agent <status>` | The agent is not `active` (for example `agent inactive`) |
| `agent deleted` | The agent no longer exists |
| `agent not in organization` | The agent is no longer in the campaign's organization |
| `removed from library` | The test is no longer in the test library |

If anything is skipped, the launch is refused the first time (the API answers `409`) and the dialog asks you to confirm. Choose **Run the rest** to dispatch only the pairs that can run, or cancel and fix the plan. Skipped pairs show as **N/A** in the matrix, with the reason on hover. If every pair is skipped, nothing runs.

### Pre-execution notices

When [pre-execution notices](../integrations/pre-execution-notices) are enabled, the dialog says so. A campaign sends **one** notice for the whole run (not one per test or host), and the tasks wait until the notice is released. The launch is a single all-or-nothing operation whether notices are on or off: either the run, its tasks, and its notice are all created, or none are.

### Limits

| Limit | Value |
|-------|-------|
| Tests per campaign | 100 |
| Agents per campaign | at least 1 |
| Tasks per run | 5,000 (a run that would exceed this is rejected) |
| Name | 120 characters |
| Description | 2000 characters |
| Framework label | 120 characters |

After you confirm, you are taken to the run's evidence page. Retries of a task (manual or automatic) stay attached to the run.

## Reading the Matrix

The evidence page shows tests as rows, hosts as columns, and one cell per pair. It refreshes every 15 seconds while anything is still in flight, and shows the **As of** time it was computed.

| State | Meaning |
|-------|---------|
| **Waiting for notice** | The task is queued and the pre-execution notice has not been released yet |
| **Running** | Queued (no notice), assigned, downloading, or executing |
| **Protected** | The test completed and the control blocked or detected it |
| **Unprotected** | The test completed and the control did not stop it |
| **Error** | The task failed |
| **Not run** | The task expired, or never produced a result |
| **N/A** | Skipped at launch |

Protected and Unprotected are decided by the same exit-code rules as the rest of the platform; see [Exit Codes and Outcomes](../analytics/exit-codes-and-outcomes).

When a pair has more than one attempt in the run (a retry), the cell shows the **latest** attempt.

### % protected

```
% protected = Protected / (Protected + Unprotected)
```

rounded to a whole number. Running, Error, Not run and N/A cells are **not** counted, so errors and skipped pairs never inflate or deflate the score. Until at least one cell is Protected or Unprotected, the value is shown as a dash.

## Exporting Evidence

- **Download CSV** produces one row per test and host with the columns `test, techniques, host, os, outcome, exit_code, completed_at, as_of`. N/A cells have an empty outcome. The file name includes the as-of time, for example `campaign-run-<run-id>-20261023T1405Z.csv`, so two exports of the same run are distinguishable.
- **Print** opens the browser print dialog with a print-ready layout (navigation hidden, light theme), suitable for saving as PDF.

Every export carries the **as-of** time: the moment the evidence was read. A run that is still in progress will change on the next export.

## Evidence snapshots

When a run starts, it stores a snapshot of the plan: the campaign name, framework label, the test and host lists, and the skipped pairs. Editing or **deleting** the campaign afterwards never changes a past run. Runs of a deleted campaign remain readable and are listed on the run history with a deleted marker.

## Permissions and Organizations

Viewing campaigns and runs requires the endpoint task **read** permission. Creating, editing, deleting and running campaigns requires the task **create** permission, the same as dispatching tasks.

A campaign always belongs to a single organization, and runs, notices and tasks inherit it. A cross-organization campaign or run behaves as not found. When `REQUIRE_ORG_ISOLATION` is enabled, callers without an organization are rejected with `403` on every campaign route.

## What Campaigns Don't Do (v1)

- No recurring schedule (use [Task Scheduling](./task-scheduling) for that; a campaign is run on demand)
- No run comparison or trend across runs
- No cancelling a run once it has started
- No dynamic membership such as "all Windows hosts" (agents are picked explicitly)
- No PDF generation on the server (use the browser's print-to-PDF)
- Not available on Vercel deployments

For endpoint details see the [Campaigns API](../../api-reference/campaigns).
