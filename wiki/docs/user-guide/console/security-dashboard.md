---
sidebar_position: 2
title: "Security Dashboard"
description: "The unified ProjectAchilles dashboard — attention banner, KPI strip, trend overview, ATT&CK coverage, fleet health, and the 7d/30d/90d range selector."
---

# Security Dashboard

`/dashboard` is the console's landing page and the single place posture is
summarised across all three data sources — the test library, the endpoint
fleet, and Elasticsearch analytics. It replaced the three separate module
dashboards in 2.1.

![Security Dashboard — attention banner, KPI strip, trend overview, severity mix, ATT&CK coverage and category breakdown](/img/screenshots/security-dashboard.png)

## Time range

The header carries a **7d / 30d / 90d** selector plus a git sync chip and a
manual refresh. The range drives the Defense Score and the trend overview, and
defaults to **90d**, matching the Analytics section's default window. For the
Defense Score the range is a **freshness window**: a test × endpoint pair counts
only if its most recent result falls inside it. The trend line shows the same
calculation as of each UTC day and always ends at the tile's value. See
[Defense Score](../analytics/defense-score.md#latest-result-score).

:::tip
90 days is the default because most fleets run scheduled bundles weekly or
monthly. A 7-day window on a monthly schedule shows an empty chart even though
the programme is healthy.
:::

## Attention banner

When something needs a human, a warning strip appears above the KPI row with
one link per issue. It is derived, not stored — each item links to the page
that resolves it:

| Item | Trigger | Links to |
|------|---------|----------|
| Agents offline | One or more enrolled agents missed their heartbeat window | `/agents` |
| Stale agents | Agents with no task in 7 days | `/agents` |
| Failed tasks | Task failures in the last 24 hours | `/tasks` |
| Outdated agents | Agents running an older binary than the newest registered version | `/agents` |
| Sync failures | The test library git sync last failed | `/tests` |

No banner means nothing crossed a threshold.

## KPI strip

Up to seven cards, each reading from a different source so a single outage
degrades one card rather than the page:

| KPI | Meaning |
|-----|---------|
| **Defense Score** | Share of test × endpoint pairs whose most recent result in the range was blocked or detected. Renders in danger colour below 60%. The caption reads `<n> pairs · ±d.d pts over <range>`. With fewer than 10 pairs, the score is muted and the caption reads `n=<n> · not enough data`. |
| **Secure Score** | Microsoft Defender Secure Score, when the integration is configured |
| **ZTA Score** | CrowdStrike Zero Trust Assessment score, when the integration is configured and licensed |
| **Total tests** | Tests in the library, with a critical/high count |
| **Avg score** | Mean test score across scored tests |
| **Agents online** | Online / enrolled, with an offline count |
| **Executions 7d** | Executions in the last 7 days (whatever the range) and the share protected. This is a volume figure, so it counts every execution, not pairs. |

## Cards

**Trend overview** — Defense Score, Secure Score, and error rate on one
30-day-rolling axis over the selected window.

**Severity** — a donut of the library's test mix by severity.

**MITRE ATT&CK coverage** — technique counts per tactic in kill-chain order,
with totals for techniques, tactics, and mapped tests. Density is rendered with
accent green at varying opacity.

**Category breakdown** — tests per category (intel-driven, cyber-hygiene,
mitre-top10, …) as a bar list, with average score and critical/high counts.

**Fleet health** and **recent executions** round out the page; a recent
execution links straight to `/analytics?expanded=<id>`, opening that run in the
executions master-detail view.

## Degradation, not redirects

Every card fetches independently. If Elasticsearch is unconfigured, the
analytics cards show a "Configure →" link to Settings while the library and
fleet cards keep working. The dashboard never redirects you away — that was the
main complaint about the old per-module dashboards.

## Related

- **[Console & Navigation](./navigation)** — the shell, shortcuts, and theme
- **[Defense Score](../analytics/defense-score)** — how the score is computed
- **[Task Execution](../agent-management/task-execution)** — the task stream behind the failed-task banner
