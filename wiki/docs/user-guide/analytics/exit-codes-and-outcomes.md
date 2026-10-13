---
title: "Exit Codes & Outcomes"
description: "Canonical reference for test exit codes, correlation flags, stage labels, and final Defense Score / SB report outcomes."
---

# Exit Codes & Outcomes

The single source of truth for how a test execution's raw exit code, EDR
correlation flags, stage labels in the UI, and final outcomes in the Defense
Score and SB compliance report relate to each other.

## 1. Exit codes — what the agent reports

| Code | Name | Meaning | Category |
|---|---|---|---|
| `0` | NormalExit | Ran, exited normally — outcome varies by context | inconclusive |
| `1` | BinaryNotRecognized | Binary not recognized / permission denied | contextual |
| `101` | Unprotected | **Attack succeeded** — endpoint did nothing | failed |
| `105` | FileQuarantinedOnExtraction | AV quarantined the file during extraction | protected |
| `126` | ExecutionPrevented | Execution blocked/prevented by AV/EDR policy | protected |
| `127` | QuarantinedOnExecution | Quarantined at execution attempt | protected |
| `200` | NoOutput | Upload confirmation — **not a test outcome** | excluded from everything |
| `259` | StillActive | Process timeout (Windows STILL_ACTIVE) | inconclusive |
| `260` | BlockedPreExecution | Blocked before launch by an ASR/app-control **policy** — technique never evaluated | inconclusive |
| `999` | UnexpectedTestError | Process died unexpectedly — crash, missing prereqs, **or EDR kill** | error |
| `> 2³¹−1` (e.g. `0xE0000027`) | *(unsigned NTSTATUS-style)* | EDR kill codes and similar — **coerced to `999` at ingestion**, original preserved in `event.ERROR_raw` | error |

:::info Exit codes never prove prevention
`999` is ambiguous by itself — it means "something killed the process or it
broke." Attribution only ever comes from EDR alert evidence (§2), never from
the exit code. This is the "evidence, not exit codes" principle.
:::

## 2. Correlation flags — written by the enrichment pass

The enrichment pass (every 5 minutes) scans recent test docs and correlates
them against synced EDR alerts:

| Flag | Set when | Qualification |
|---|---|---|
| `defender_detected` / `crowdstrike_detected` | Alert evidence matches hostname + bundle UUID in filename/path, within −5/+30 min of the test | — |
| `*_stage_detected` | Alert evidence names the **stage's own binary** (`<bundle-uuid>-<control>.exe`) | — |
| `crowdstrike_prevented` (+ `crowdstrike_prevention_action`) | Matched alert carries a Falcon prevention disposition (`process_killed`, `quarantined`, `blocked`) | **Stage-binary matches always qualify. Bundle-wide matches only if the stage never reached a conclusive outcome** (exit ∉ `{101, 105, 126, 127}`). A failed kill (`kill_action_failed`) never qualifies |

**Which documents are scanned:** exit codes `[0, 1, 101, 105, 126, 127, 259, 999]`
— so EDR-killed stages (999) are eligible. Deliberately **not scanned**:

- `200` — upload confirmation, not a test outcome
- `260` — a policy block before execution, including the ASR rule the platform
  excludes by design (see
  [Defender ASR exclusion](../integrations/microsoft-defender)); counting it
  would conflate our own configuration with detection

## 3. Stage labels in the UI

Each stage row in the executions view resolves to exactly one label, by
precedence (top wins):

| Label | Condition | Meaning |
|---|---|---|
| **Protected** | exit ∈ `{105, 126, 127}` | Endpoint blocked/quarantined at the OS level |
| **Prevented** | `crowdstrike_prevented` (or detected flags + confirmed prevention action) | Vendor-confirmed kill/quarantine/block — shows the action, e.g. "Prevented (process killed)" |
| **Detected** | `*_stage_detected` or `*_detected` | The EDR saw it and alerted, but didn't stop it |
| **Unprotected** | exit 101 | Attack ran to completion, nothing reacted |
| **Inconclusive** | everything else (0, 1, 259, 260, 999, missing) | Can't judge — error, timeout, policy block, or unconfirmed kill |

Bundle rows roll up with the same precedence:
Protected > Prevented > Detected > Unprotected.

## 4. Final outcomes

### Defense Score (Analytics dashboards)

- **Strict score**: `protected (105/126/127) / conclusive (101 + 105 + 126 + 127)`
- **Combined score** ("detected counts as protected"): adds
  `defender_detected OR crowdstrike_detected` to the protected side.
  `crowdstrike_prevented` ⊆ `crowdstrike_detected`, so prevented stages are
  covered automatically.
- Error codes (`0`, `1`, `259`, `999`) feed the **Error Rate**, not the score.
- `200` and `260` are excluded from both.

### SB compliance report

Outcomes: `PREVENTED / DETECTED / MISSED / EXPOSED / NOT_RUN / ERROR`.

| Exit | EDR flags | Outcome | Attribution |
|---|---|---|---|
| 105 / 126 / 127 | any | **PREVENTED** | `preventedBy`: vendor(s) |
| 999 / 259 / 0 / none | `crowdstrike_prevented` | **PREVENTED** | `preventedBy`: CrowdStrike Falcon |
| 101 / 0 | detected flag(s) | **DETECTED** | `detectedBy`: vendor(s), both when both flagged |
| 101 / 0 | none, tactic ∈ `{exfiltration, impact}` | **EXPOSED** | — |
| 101 / 0 | none, other tactics | **MISSED** | — |
| 200 / 259 / 260 | any | **ERROR** (with "inconclusive" note) | — |
| — (no document) | — | **NOT_RUN** | — |

## 5. Worked examples

| Scenario | Exit | Evidence | Label / SB outcome |
|---|---|---|---|
| Falcon kills the ransomware stage at launch | `0xE0000027` → 999 | Stage-binary alert match, `process_killed` disposition | **Prevented (process killed)** / PREVENTED |
| Sibling stage already ran to completion before the kill | 101 | Bundle-wide alert match only | **Detected** / DETECTED — a succeeded stage is never upgraded to Prevented |
| Stage runs, nothing reacts | 101, no alert | none | **Unprotected** / MISSED (or EXPOSED for exfiltration/impact tactics) |
| Stage dies, no alert anywhere | 999, no alert | none | **Inconclusive** / ERROR — a kill is never assumed |
| Defender ASR policy blocks launch | 260 | policy, not detection | **Inconclusive** / ERROR — never counted |
| Defender quarantines at extraction | 105 | — | **Protected** / PREVENTED |

## Related

- [Defense Score](./defense-score) — how the score is computed
- [Microsoft Defender integration](../integrations/microsoft-defender) — Defender correlation and auto-resolve
- [CrowdStrike Falcon integration](../integrations/crowdstrike) — prevention dispositions, Falcon console deep links
