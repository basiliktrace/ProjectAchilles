// Bulk EDR alert correlation for the execution report (spec §5.3).
//
// The console correlates one stage at a time (alerts-for-test) and repeats
// the identical evidence query for every stage of a run. The report
// deduplicates to ONE evidence sub-search per run, batched with msearch,
// then runs the technique+host fallback only for runs that came back empty.
// Those are the console's tiers whenever a hostname is known: its two
// fallbacks build the same query once a hostname is present.

import type { Client } from '@elastic/elasticsearch';
import {
  buildAlertTimeWindowQuery as defenderTimeWindow,
  buildDefenderEvidenceQuery,
  type TestEvidenceInput,
} from '../defender/evidence-correlation.js';
import {
  buildAlertTimeWindowQuery as crowdstrikeTimeWindow,
  buildCrowdStrikeEvidenceQuery,
} from '../crowdstrike/evidence-correlation.js';
import { DEFENDER_INDEX } from '../defender/index-management.js';
import { CROWDSTRIKE_INDEX } from '../crowdstrike/index-management.js';
import { projectAlertHit } from '../alerts/alertHit.js';
import type { ReportAlert } from '../../types/reports.js';

/** Same lead and default post-window the console uses. */
const PRE_WINDOW_MS = 5 * 60 * 1000;
const POST_WINDOW_MS = 30 * 60 * 1000;
export const CORRELATION_BATCH_SIZE = 100;
const HITS_PER_RUN = 50;
const ALERT_SOURCE_FIELDS = [
  'alert_id', 'alert_title', 'description', 'severity', 'status', 'category', 'service_source',
  'mitre_techniques', 'created_at', 'updated_at', 'resolved_at', 'recommended_actions',
  'evidence_filenames', 'prevention_action', 'portal_url', 'f0rtika.auto_resolved_at',
  'f0rtika.auto_resolve_mode', 'f0rtika.auto_resolve_error',
];

export interface VendorAdapter {
  vendor: ReportAlert['vendor'];
  index: string;
  buildEvidenceQuery: (input: TestEvidenceInput) => Record<string, unknown> | null;
  buildTimeWindowQuery: (fromIso: string, toIso: string) => Record<string, unknown>;
}

export const DEFENDER_ADAPTER: VendorAdapter = {
  vendor: 'defender',
  index: DEFENDER_INDEX,
  buildEvidenceQuery: buildDefenderEvidenceQuery,
  buildTimeWindowQuery: defenderTimeWindow,
};

export const CROWDSTRIKE_ADAPTER: VendorAdapter = {
  vendor: 'crowdstrike',
  index: CROWDSTRIKE_INDEX,
  buildEvidenceQuery: buildCrowdStrikeEvidenceQuery,
  buildTimeWindowQuery: crowdstrikeTimeWindow,
};

export interface CorrelationRun {
  key: string;
  /** Bundle UUID or standalone test UUID — the evidence binary prefix. */
  testKey: string;
  hostname: string;
  completedAt: string;
  bundleName?: string;
  techniques: string[];
}

export interface CorrelationResult {
  alerts: Map<string, ReportAlert[]>;
  /** false when the deadline cut correlation short. */
  complete: boolean;
}

export function buildHostTechniqueQuery(adapter: VendorAdapter, run: CorrelationRun): Record<string, unknown> {
  const completed = Date.parse(run.completedAt);
  const host = `${run.hostname.toUpperCase()}*`;
  return {
    bool: {
      must: [
        { term: { doc_type: 'alert' } },
        { terms: { mitre_techniques: run.techniques } },
        {
          bool: {
            should: [
              { wildcard: { evidence_hostnames: { value: host } } },
              { wildcard: { 'evidence_hostnames.keyword': { value: host } } },
            ],
            minimum_should_match: 1,
          },
        },
        adapter.buildTimeWindowQuery(
          new Date(completed - PRE_WINDOW_MS).toISOString(),
          new Date(completed + POST_WINDOW_MS).toISOString(),
        ),
      ],
    },
  };
}

function toReportAlert(adapter: VendorAdapter, source: Record<string, unknown>, run: CorrelationRun): ReportAlert {
  const p = projectAlertHit(source, run.testKey);
  return {
    vendor: adapter.vendor,
    title: p.alert_title,
    severity: p.severity,
    status: p.status,
    createdAt: p.created_at,
    stageControlId: p.attribution === 'stage' ? p.attributed_control_id ?? null : null,
    preventionAction: p.prevention_action ?? null,
    portalUrl: p.portal_url ?? null,
    autoResolvedAt: p.auto_resolved_at ?? null,
  };
}

interface Entry { run: CorrelationRun; query: Record<string, unknown> }

/** One msearch; a sub-response with `error` (e.g. missing index) yields no hits. */
async function msearchSources(
  client: Client,
  adapter: VendorAdapter,
  entries: Entry[],
): Promise<Record<string, unknown>[][]> {
  if (entries.length === 0) return [];
  const searches = entries.flatMap(({ query }) => [
    { index: adapter.index },
    { size: HITS_PER_RUN, query, sort: [{ created_at: { order: 'asc' } }], _source: ALERT_SOURCE_FIELDS },
  ]);
  const response = await client.msearch({ searches } as never);
  return ((response as { responses?: unknown[] }).responses ?? []).map((r) => {
    const sub = r as { error?: unknown; hits?: { hits?: { _source?: Record<string, unknown> }[] } };
    return sub.error ? [] : (sub.hits?.hits ?? []).map((h) => h._source ?? {});
  });
}

export async function correlateRuns(
  client: Client,
  adapter: VendorAdapter,
  runs: CorrelationRun[],
  opts: { deadline: number; batchSize?: number },
): Promise<CorrelationResult> {
  const alerts = new Map<string, ReportAlert[]>();
  const batchSize = opts.batchSize ?? CORRELATION_BATCH_SIZE;
  const unmatched: CorrelationRun[] = [];

  const record = (entries: Entry[], results: Record<string, unknown>[][], onEmpty?: (run: CorrelationRun) => void) => {
    entries.forEach(({ run }, i) => {
      const hits = results[i] ?? [];
      if (hits.length > 0) alerts.set(run.key, hits.map((s) => toReportAlert(adapter, s, run)));
      else onEmpty?.(run);
    });
  };

  // Tier 1: evidence (the same query the enrichment pass uses).
  for (let i = 0; i < runs.length; i += batchSize) {
    if (Date.now() > opts.deadline) return { alerts, complete: false };
    const entries: Entry[] = [];
    for (const run of runs.slice(i, i + batchSize)) {
      const query = adapter.buildEvidenceQuery({
        test_uuid: run.testKey,
        routing_event_time: run.completedAt,
        routing_hostname: run.hostname,
        bundle_name: run.bundleName,
      });
      if (query) entries.push({ run, query });
      else unmatched.push(run);
    }
    record(entries, await msearchSources(client, adapter, entries), (run) => unmatched.push(run));
  }

  // Tier 2: technique + host, only for runs the evidence tier missed.
  const fallback = unmatched.filter((r) => r.techniques.length > 0);
  for (let i = 0; i < fallback.length; i += batchSize) {
    if (Date.now() > opts.deadline) return { alerts, complete: false };
    const entries = fallback.slice(i, i + batchSize).map((run) => ({ run, query: buildHostTechniqueQuery(adapter, run) }));
    record(entries, await msearchSources(client, adapter, entries));
  }

  return { alerts, complete: true };
}
