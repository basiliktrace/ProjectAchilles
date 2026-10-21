import type { Client } from '@elastic/elasticsearch';

interface NameBucket {
  key: string;
  top?: { hits?: { hits?: Array<{ _source?: { f0rtika?: Record<string, unknown> } }> } };
}

function nameOf(b: NameBucket, field: string): string | undefined {
  const v = b.top?.hits?.hits?.[0]?._source?.f0rtika?.[field];
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * Resolve display names for test/bundle uuids in ONE ES request.
 * Bundle name wins for a bundle uuid. Returns an empty Map on any ES error
 * (logged, never thrown).
 */
export async function resolveTestNames(
  client: Client,
  indexPattern: string,
  uuids: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (uuids.length === 0) return names;

  const agg = (field: string, nameField: string) => ({
    terms: { field, size: uuids.length },
    aggs: {
      top: { top_hits: { size: 1, _source: [`f0rtika.${nameField}`] } },
    },
  });

  try {
    const res = await client.search({
      index: indexPattern,
      size: 0,
      query: {
        bool: {
          should: [
            { terms: { 'f0rtika.test_uuid': uuids } },
            { terms: { 'f0rtika.bundle_id': uuids } },
          ],
          minimum_should_match: 1,
        },
      },
      aggs: {
        by_test: agg('f0rtika.test_uuid', 'test_name'),
        by_bundle: agg('f0rtika.bundle_id', 'bundle_name'),
      },
    });
    const aggs = res.aggregations as
      | { by_test?: { buckets?: NameBucket[] }; by_bundle?: { buckets?: NameBucket[] } }
      | undefined;

    for (const b of aggs?.by_test?.buckets ?? []) {
      const n = nameOf(b, 'test_name');
      if (n) names.set(b.key, n);
    }
    for (const b of aggs?.by_bundle?.buckets ?? []) {
      const n = nameOf(b, 'bundle_name');
      if (n) names.set(b.key, n);
    }
  } catch (err) {
    console.error('resolveTestNames failed:', err instanceof Error ? err.message : err);
    return new Map();
  }
  return names;
}
