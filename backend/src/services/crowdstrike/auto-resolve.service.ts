// Auto-resolve pillar for the CrowdStrike Falcon integration.
//
// Reads alerts tagged by the enrichment pass (f0rtika.achilles_correlated:true)
// and PATCHes them to status=closed with an audit-trail comment appended in
// the same call, so Achilles continuous-validation activity doesn't flood
// the SOC queue.
//
// This service is the WRITE counterpart to the READ-only correlation done by
// CrowdStrikeEnrichmentService. It intentionally never writes to test docs —
// Defense Score reads those, and this feature must not affect scoring.
// (See the plan's Mental Model section for why that invariant matters.)
//
// Operational modes (persisted in integration settings, mutable at runtime):
//   - disabled  → no ES or Falcon calls, zero result
//   - dry_run   → compute candidates, log [CrowdStrike-AutoResolve-DryRun],
//                 write receipts with mode='dry_run'; NO Falcon PATCH
//   - enabled   → PATCH via FalconClient.updateAlerts, write receipts
//                 with mode='enabled' on success

import type { Client } from '@elastic/elasticsearch';
import type { FalconClient } from './falcon-client.js';
import { FalconApiError } from './falcon-client.js';
import { CROWDSTRIKE_INDEX } from './index-management.js';
import type {
  AutoResolveMode,
  AutoResolvePassOptions,
  AutoResolvePassResult,
} from '../../types/crowdstrike.js';

const DEFAULT_MAX_PER_PASS = 30;
const DEFAULT_MAX_DURATION_MS = 30_000;

interface Candidate {
  alertId: string;
  alertDocId: string;
  alertDocIndex: string;
  testUuid: string;
}

/**
 * Map a per-item error from the PATCH response envelope to the
 * `auto_resolve_error` receipt keyword. CrowdStrike returns HTTP 200 with
 * per-item failures in `errors[]` — a 404-coded item means the alert was
 * deleted upstream and should be shelved, not retried forever.
 */
function mapItemErrorCode(err: { code: number | string; id?: string; message: string }): string {
  if (String(err.code) === '404') return 'not_found';
  return `${err.code}: ${err.message}`.slice(0, 200);
}

export class CrowdStrikeAutoResolveService {
  constructor(
    private readonly esClient: Client,
    private readonly falconClient: FalconClient,
    private readonly mode: AutoResolveMode,
  ) {}

  async runAutoResolvePass(
    options: AutoResolvePassOptions = {},
  ): Promise<AutoResolvePassResult> {
    const startedAt = Date.now();
    const mode = options.modeOverride ?? this.mode;
    const maxPerPass = options.maxPerPass ?? DEFAULT_MAX_PER_PASS;
    const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;

    const result: AutoResolvePassResult = {
      mode,
      candidates: 0,
      patched: 0,
      wouldPatch: 0,
      skipped: 0,
      errors: [],
      durationMs: 0,
    };

    // Disabled mode: complete no-op. No ES calls, no Falcon calls.
    // This is the customer's default until they opt in.
    if (mode === 'disabled') {
      result.durationMs = Date.now() - startedAt;
      return result;
    }

    try {
      const candidates = await this.findCandidates(maxPerPass);
      result.candidates = candidates.length;

      for (const candidate of candidates) {
        // Duration cap — stops the pass cleanly between candidates so the
        // next sync cycle isn't blocked on a slow Falcon tenant.
        if (Date.now() - startedAt > maxDurationMs) break;

        // Defensive: a correlation write may have landed without the test_uuid
        // field on older docs. Skip rather than emit a malformed PATCH/receipt.
        if (!candidate.alertId || !candidate.testUuid) {
          result.skipped += 1;
          continue;
        }

        const commentText = this.buildCommentText(candidate.testUuid);

        if (mode === 'enabled') {
          const patchOutcome = await this.patchAlert(candidate.alertId, commentText);

          if (patchOutcome.error === null && patchOutcome.itemError === null) {
            result.patched += 1;
            await this.writeReceipt(candidate, 'enabled');
            continue;
          }

          if (patchOutcome.error instanceof FalconApiError && patchOutcome.error.statusCode === 403) {
            // Permission missing ('Alerts: write' not granted) — the entire
            // pass is blocked until the scope is granted. Halt cleanly so we
            // don't spam 403s across candidates.
            result.errors.push(`403: ${patchOutcome.error.message}`);
            break;
          }

          if (patchOutcome.error instanceof FalconApiError && patchOutcome.error.statusCode === 404) {
            // Alert deleted upstream — write a receipt (with error recorded)
            // so we don't rescan this candidate on every future pass.
            await this.writeReceipt(candidate, 'enabled', 'not_found');
            result.errors.push(`${candidate.alertId}: not_found`);
            continue;
          }

          if (patchOutcome.itemError !== null) {
            // HTTP 200 but the response envelope reported a per-item failure
            // for this composite_id. Write an error receipt so the alert
            // isn't rescanned forever.
            await this.writeReceipt(candidate, 'enabled', patchOutcome.itemError);
            result.errors.push(`${candidate.alertId}: ${patchOutcome.itemError}`);
            continue;
          }

          // Transient or unknown error — record and move on. NO receipt,
          // so the next pass re-attempts the PATCH.
          const msg = patchOutcome.error instanceof Error ? patchOutcome.error.message : String(patchOutcome.error);
          result.errors.push(`${candidate.alertId}: ${msg}`);
          continue;
        }

        // dry_run: log and write a receipt (with mode='dry_run') so we
        // don't re-log the same candidate on every 5-min cycle.
        console.log(
          `[CrowdStrike-AutoResolve-DryRun] would_patch alert_id=${candidate.alertId} test_uuid=${candidate.testUuid}`,
        );
        result.wouldPatch += 1;
        await this.writeReceipt(candidate, 'dry_run');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`pass: ${msg}`);
    }

    result.durationMs = Date.now() - startedAt;
    return result;
  }

  // ---------------------------------------------------------------------------
  // Candidate selection
  // ---------------------------------------------------------------------------

  private async findCandidates(size: number): Promise<Candidate[]> {
    // Whitelist on status='new': we only auto-resolve alerts Falcon has not
    // yet acted on. Specifically excluded:
    //   - 'closed'      — someone (human or Falcon's automation) has already
    //                     closed the alert; leave it alone, even if the
    //                     handling doesn't match what we'd have used.
    //   - 'in_progress' — a human operator is actively triaging. PATCHing the
    //                     alert under them would be a UX surprise; respect their
    //                     acknowledgment.
    //   - 'reopened'    — a human deliberately reopened it; same reasoning.
    //   - unknown / future statuses — fail closed. If CrowdStrike ever adds a
    //     new status value, default to NOT auto-resolving until the policy is
    //     intentionally updated.
    const response = await this.esClient.search({
      index: CROWDSTRIKE_INDEX,
      size,
      query: {
        bool: {
          filter: [
            { term: { doc_type: 'alert' } },
            { term: { 'f0rtika.achilles_correlated': true } },
            { term: { status: 'new' } },
          ],
          must_not: [
            { term: { 'f0rtika.auto_resolved': true } },
          ],
        },
      },
      // Oldest first so long-standing candidates resolve before fresh ones.
      sort: [{ 'f0rtika.achilles_matched_at': 'asc' }],
    } as any);

    const hits = ((response as any).hits?.hits ?? []) as any[];
    return hits
      .map((h): Candidate | null => {
        const src = h._source ?? {};
        const f0rtika = src.f0rtika ?? {};
        const alertId = typeof src.alert_id === 'string' ? src.alert_id : '';
        const testUuid = typeof f0rtika.achilles_test_uuid === 'string' ? f0rtika.achilles_test_uuid : '';
        if (!alertId) return null;
        return {
          alertId,
          alertDocId: h._id,
          alertDocIndex: h._index,
          testUuid,
        };
      })
      .filter((c): c is Candidate => c !== null);
  }

  // ---------------------------------------------------------------------------
  // Falcon PATCH (with error capture rather than throw)
  // ---------------------------------------------------------------------------

  private buildCommentText(testUuid: string): string {
    return `Achilles test ${testUuid} — authorized continuous validation. Resolved automatically by Project Achilles.`;
  }

  /**
   * PATCH one alert to status=closed with the audit-trail comment appended
   * in the same call (CrowdStrike's /alerts/entities/alerts/v3 accepts both
   * in one body — no separate comments endpoint like Graph's).
   *
   * Returns { error: null, itemError: null } on success. `error` is a thrown
   * FalconApiError/Error (non-2xx); `itemError` is a mapped per-item failure
   * from the 200 response envelope (CrowdStrike returns 200 with errors[]).
   * Never throws.
   */
  private async patchAlert(
    alertId: string,
    commentText: string,
  ): Promise<{ error: unknown | null; itemError: string | null }> {
    try {
      const result = await this.falconClient.updateAlerts([alertId], {
        status: 'closed',
        comment: commentText,
      });

      // Inspect the envelope: CrowdStrike reports per-item failures with
      // HTTP 200. Find the error entry for THIS composite_id (or any entry
      // when ids aren't echoed back).
      const itemError = result.errors.find((e) => e.id === alertId) ?? (result.errors.length > 0 ? result.errors[0] : undefined);
      if (itemError) {
        return { error: null, itemError: mapItemErrorCode(itemError) };
      }
      return { error: null, itemError: null };
    } catch (err) {
      return { error: err, itemError: null };
    }
  }

  // ---------------------------------------------------------------------------
  // Receipt writes (ES update on the alert doc)
  // ---------------------------------------------------------------------------

  /**
   * Mark the alert doc so the next pass skips it. In dry-run this prevents
   * perpetual re-logging; in enabled mode it's the audit trail for the PATCH.
   * Errors here are non-fatal — ES update retry_on_conflict handles races.
   */
  private async writeReceipt(
    candidate: Candidate,
    mode: AutoResolveMode,
    error?: string,
  ): Promise<void> {
    const doc: Record<string, unknown> = {
      f0rtika: {
        auto_resolved: true,
        auto_resolved_at: new Date().toISOString(),
        auto_resolve_mode: mode,
        ...(error ? { auto_resolve_error: error } : {}),
      },
    };
    try {
      await this.esClient.update({
        index: candidate.alertDocIndex,
        id: candidate.alertDocId,
        doc,
        retry_on_conflict: 3,
      } as any);
    } catch {
      // Non-fatal: if the receipt write fails, the next pass will re-PATCH.
      // Falcon's PATCH is idempotent for a closed→closed transition.
    }
  }
}
