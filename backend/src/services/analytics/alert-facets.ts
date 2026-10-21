// Vendor-neutral filter and facet builders for the integration alert feeds
// (CrowdStrike, Defender). Each vendor passes its closed-status set and an
// optional vendor facet (CrowdStrike prevention, Defender product).
// Keep byte-identical in backend/ and backend-serverless/.

import { windowRange } from './integration-window.js';
import type { AlertFacetCounts, AlertSource, TimeWindow } from './integration-window.js';
import type {
  AggregationsAggregationContainer,
  QueryDslQueryContainer,
} from '@elastic/elasticsearch/lib/api/types.js';

/** An alert the enrichment pass matched to an Achilles test. */
export const LINKED: QueryDslQueryContainer = { term: { 'f0rtika.achilles_correlated': true } };
/** Everything not linked, including docs that predate the correlation field. */
export const ORGANIC: QueryDslQueryContainer = { bool: { must_not: [LINKED] } };
/**
 * Alerts Achilles really resolved in the vendor console. Receipts are also
 * written in dry-run mode and on failed PATCHes, so `auto_resolved: true`
 * alone is not enough (same rule as projectAlertHit's auto_resolved_at).
 */
export const RESOLVED_BY_ACHILLES: QueryDslQueryContainer = {
  bool: {
    filter: [
      { term: { 'f0rtika.auto_resolved': true } },
      { term: { 'f0rtika.auto_resolve_mode': 'enabled' } },
    ],
    must_not: [{ exists: { field: 'f0rtika.auto_resolve_error' } }],
  },
};

export function sourceFilter(source?: AlertSource): QueryDslQueryContainer | null {
  if (source === 'test') return LINKED;
  if (source === 'organic') return ORGANIC;
  return null;
}

export function severityFilter(severities?: string[]): QueryDslQueryContainer | null {
  return severities && severities.length > 0 ? { terms: { severity: severities } } : null;
}

/** AND of the non-null clauses; match_all when there are none. */
export function allOf(...clauses: Array<QueryDslQueryContainer | null>): QueryDslQueryContainer {
  const present = clauses.filter((c): c is QueryDslQueryContainer => c !== null);
  return present.length > 0 ? { bool: { filter: present } } : { match_all: {} };
}

/** Alert docs, optionally limited to a created_at window. */
export function alertDocs(window: TimeWindow | null): QueryDslQueryContainer {
  const range = windowRange('created_at', window);
  return range
    ? { bool: { must: [{ term: { doc_type: 'alert' } }, range] } }
    : { term: { doc_type: 'alert' } };
}

export function firstString(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first ? first : null;
}

interface FacetBucket { doc_count?: number }

export interface FacetAggregations {
  facet_source?: FacetBucket & { split?: { buckets?: { test?: FacetBucket; organic?: FacetBucket } } };
  facet_severity?: { split?: { buckets?: Array<{ key: string; doc_count: number }> } };
  facet_filtered?: FacetBucket & { auto_resolved?: FacetBucket } & Record<string, unknown>;
  facet_linked_open?: { split?: FacetBucket };
}

/** A vendor-specific facet computed under the all-filters aggregation. */
export interface VendorFacet {
  /** Sub-aggregation name under `facet_filtered`. */
  key: string;
  agg: AggregationsAggregationContainer;
  /** Reads that sub-aggregation's response into the counts field(s) it owns. */
  read: (response: unknown) => Partial<AlertFacetCounts>;
}

export interface AlertFacetOptions {
  source?: AlertSource;
  severities?: string[];
  window: TimeWindow | null;
  /** Vendor statuses that mean closed; the linked-open tile excludes them. */
  closedStatuses: string[];
  vendorFacet?: VendorFacet;
}

/**
 * Facet aggregations for an alert feed, plus a reader for the response.
 * Each facet applies every filter except its own, so a segment's count is
 * what the list would show if that segment were picked. Source and severity
 * go in the caller's post_filter, never the query, for the same reason.
 * The linked-open tile only has the window, so it ignores the query too.
 */
export function alertFacets(opts: AlertFacetOptions) {
  const source = sourceFilter(opts.source);
  const severity = severityFilter(opts.severities);
  const range = windowRange('created_at', opts.window);

  const aggs: Record<string, AggregationsAggregationContainer> = {
    facet_source: {
      filter: allOf(severity),
      aggs: { split: { filters: { filters: { test: LINKED, organic: ORGANIC } } } },
    },
    facet_severity: {
      filter: allOf(source),
      aggs: { split: { terms: { field: 'severity', size: 10 } } },
    },
    facet_filtered: {
      filter: allOf(source, severity),
      aggs: {
        auto_resolved: { filter: RESOLVED_BY_ACHILLES },
        ...(opts.vendorFacet ? { [opts.vendorFacet.key]: opts.vendorFacet.agg } : {}),
      },
    },
    facet_linked_open: {
      global: {},
      aggs: {
        split: {
          filter: {
            bool: {
              filter: [{ term: { doc_type: 'alert' } }, ...(range ? [range] : []), LINKED],
              must_not: [{ terms: { status: opts.closedStatuses } }],
            },
          },
        },
      },
    },
  };

  const read = (aggregations: unknown): AlertFacetCounts => {
    const a = (aggregations ?? {}) as FacetAggregations;
    const bySeverity: Record<string, number> = {};
    for (const b of a.facet_severity?.split?.buckets ?? []) bySeverity[b.key] = b.doc_count;
    const vendor = opts.vendorFacet;
    return {
      bySource: {
        all: a.facet_source?.doc_count ?? 0,
        test: a.facet_source?.split?.buckets?.test?.doc_count ?? 0,
        organic: a.facet_source?.split?.buckets?.organic?.doc_count ?? 0,
      },
      bySeverity,
      autoResolved: a.facet_filtered?.auto_resolved?.doc_count ?? 0,
      linkedOpen: a.facet_linked_open?.split?.doc_count ?? 0,
      ...(vendor ? vendor.read(a.facet_filtered?.[vendor.key]) : {}),
    };
  };

  return { aggs, read };
}
