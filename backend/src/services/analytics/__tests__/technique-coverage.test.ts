import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import type { QueryDslQueryContainer } from '@elastic/elasticsearch/lib/api/types.js';
import {
  COVERAGE_DEFAULT_DAYS,
  defaultCoverageWindow,
  detectedClause,
  getTechniqueCoverage,
  preventedClause,
} from '../technique-coverage.js';
import type { CoverageVendor } from '../technique-coverage.js';
import { enrichmentEligibleClauses } from '../enrichment-eligibility.js';
import { attackSimulationExclusions } from '../attack-simulation-filter.js';

const mockSearch = vi.fn();
const client = { search: mockSearch } as unknown as Client;

const WINDOW = { from: '2026-09-20T00:00:00Z', to: '2026-10-20T00:00:00Z' };

function opts(vendor: CoverageVendor = 'crowdstrike') {
  return { vendor, resultsIndex: 'achilles-results-*', alertIndex: `achilles-${vendor}`, window: WINDOW };
}

interface TechniqueFixture { key: string; doc_count: number; prevented: number; detected: number }

function resultsResponse(total: number, overall: { prevented: number; detected: number }, techniques: TechniqueFixture[]) {
  return {
    hits: { total: { value: total, relation: 'eq' }, hits: [] },
    aggregations: {
      overall: { buckets: { prevented: { doc_count: overall.prevented }, detected: { doc_count: overall.detected } } },
      techniques: {
        buckets: techniques.map((t) => ({
          key: t.key,
          doc_count: t.doc_count,
          outcome: { buckets: { prevented: { doc_count: t.prevented }, detected: { doc_count: t.detected } } },
        })),
      },
    },
  };
}

function alertResponse(counts: Record<string, number>) {
  return {
    hits: { total: { value: 0, relation: 'eq' }, hits: [] },
    aggregations: {
      techniques: { buckets: Object.entries(counts).map(([key, doc_count]) => ({ key, doc_count })) },
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal evaluator for the ES query DSL subset the predicates use, so the
// tests pin the predicate's *semantics* against concrete documents, not just
// its shape. Supports term, exists and bool (filter/must/should/must_not,
// minimum_should_match).
// ---------------------------------------------------------------------------
type Doc = Record<string, unknown>;
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function matches(q: QueryDslQueryContainer, doc: Doc): boolean {
  if (q.term) {
    const [field, value] = Object.entries(q.term)[0];
    return field in doc && doc[field] === value;
  }
  if (q.exists) return q.exists.field in doc && doc[q.exists.field] !== null && doc[q.exists.field] !== undefined;
  if (q.bool) {
    const b = q.bool;
    const required = [...asArray(b.filter), ...asArray(b.must)];
    if (!required.every((c) => matches(c, doc))) return false;
    if (asArray(b.must_not).some((c) => matches(c, doc))) return false;
    const should = asArray(b.should);
    if (should.length > 0) {
      const min = Number(b.minimum_should_match ?? (required.length > 0 ? 0 : 1));
      if (should.filter((c) => matches(c, doc)).length < min) return false;
    }
    return true;
  }
  throw new Error(`unsupported clause: ${JSON.stringify(q)}`);
}

describe('technique coverage', () => {
  beforeEach(() => mockSearch.mockReset());

  describe.each<CoverageVendor>(['crowdstrike', 'defender'])('predicates for %s', (v) => {
    const stage = `f0rtika.${v}_stage_detected`;
    const wide = `f0rtika.${v}_detected`;
    const prev = `f0rtika.${v}_prevented`;

    const bundle = 'f0rtika.is_bundle_control';

    it(`builds the R13 detected predicate for ${v}`, () => {
      expect(detectedClause(v)).toEqual({
        bool: {
          should: [
            { term: { [stage]: true } },
            { bool: { filter: [{ term: { [wide]: true } }], must_not: [{ term: { [bundle]: true } }] } },
            { term: { [prev]: true } },
          ],
          minimum_should_match: 1,
        },
      });
      expect(preventedClause(v)).toEqual({ term: { [prev]: true } });
    });

    // Enrichment only ever writes the flags as `true`; a missing flag means "not matched".
    it('does NOT credit a bundle stage matched only by the wide (bundle-UUID) query', () => {
      expect(matches(detectedClause(v), { [bundle]: true, [wide]: true })).toBe(false);
      expect(matches(preventedClause(v), { [bundle]: true, [wide]: true })).toBe(false);
    });

    it('credits a bundle stage by its own stage flag', () => {
      expect(matches(detectedClause(v), { [bundle]: true, [stage]: true })).toBe(true);
      expect(matches(detectedClause(v), { [bundle]: true, [wide]: true, [stage]: true })).toBe(true);
    });

    it('credits a standalone test by its own detection flag', () => {
      expect(matches(detectedClause(v), { [wide]: true })).toBe(true);
      expect(matches(detectedClause(v), { [bundle]: false, [wide]: true })).toBe(true);
      expect(matches(detectedClause(v), { [stage]: true })).toBe(true);
      expect(matches(detectedClause(v), {})).toBe(false);
      expect(matches(detectedClause(v), { [bundle]: true })).toBe(false);
    });

    it('a vendor-confirmed prevention counts as prevented and detected', () => {
      expect(matches(preventedClause(v), { [prev]: true })).toBe(true);
      expect(matches(detectedClause(v), { [prev]: true })).toBe(true);
      expect(matches(detectedClause(v), { [bundle]: true, [prev]: true })).toBe(true);
      expect(matches(preventedClause(v), { [stage]: true })).toBe(false);
      expect(matches(preventedClause(v), { [wide]: true })).toBe(false);
    });

    it(`puts the ${v} predicates into both the overall and per-technique filters aggs`, async () => {
      mockSearch
        .mockResolvedValueOnce(resultsResponse(1, { prevented: 0, detected: 1 }, [{ key: 'T1486', doc_count: 1, prevented: 0, detected: 1 }]))
        .mockResolvedValueOnce(alertResponse({}));
      await getTechniqueCoverage(client, opts(v));

      const req = mockSearch.mock.calls[0][0];
      const expected = { filters: { prevented: preventedClause(v), detected: detectedClause(v) } };
      expect(req.aggs.overall.filters).toEqual(expected);
      expect(req.aggs.techniques.terms).toEqual({ field: 'f0rtika.techniques', size: 500 });
      expect(req.aggs.techniques.aggs.outcome.filters).toEqual(expected);
      const other = v === 'crowdstrike' ? 'defender' : 'crowdstrike';
      expect(JSON.stringify(req)).not.toContain(other);
    });
  });

  it('applies eligibility, exclusions and the window to the results query', async () => {
    mockSearch
      .mockResolvedValueOnce(resultsResponse(1, { prevented: 0, detected: 0 }, [{ key: 'T1486', doc_count: 1, prevented: 0, detected: 0 }]))
      .mockResolvedValueOnce(alertResponse({}));
    await getTechniqueCoverage(client, opts());

    const req = mockSearch.mock.calls[0][0];
    expect(req.index).toBe('achilles-results-*');
    expect(req.size).toBe(0);
    expect(req.track_total_hits).toBe(true);
    expect(req.query.bool.filter).toEqual([
      { range: { 'routing.event_time': { gte: WINDOW.from, lte: WINDOW.to } } },
      ...enrichmentEligibleClauses(),
    ]);
    expect(req.query.bool.must_not).toEqual(attackSimulationExclusions());
  });

  it('counts alerts by exact technique id in the created_at window, doc_type alert only', async () => {
    mockSearch
      .mockResolvedValueOnce(resultsResponse(3, { prevented: 0, detected: 0 }, [
        { key: 'T1486', doc_count: 2, prevented: 0, detected: 0 },
        { key: 'T1574.002', doc_count: 1, prevented: 0, detected: 0 },
      ]))
      .mockResolvedValueOnce(alertResponse({ T1486: 4, T1574: 9 }));
    const res = await getTechniqueCoverage(client, opts('defender'));

    const req = mockSearch.mock.calls[1][0];
    expect(req.index).toBe('achilles-defender');
    expect(req.size).toBe(0);
    expect(req.query.bool.filter).toEqual([
      { term: { doc_type: 'alert' } },
      { range: { created_at: { gte: WINDOW.from, lte: WINDOW.to } } },
    ]);
    expect(req.aggs.techniques.terms).toEqual({
      field: 'mitre_techniques', size: 500, include: ['T1486', 'T1574.002'],
    });
    // No sub-technique roll-up: the parent's T1574 alerts are not credited to T1574.002.
    expect(res.byTechnique.find((t) => t.technique === 'T1574.002')?.alerts).toBe(0);
    expect(res.byTechnique.find((t) => t.technique === 'T1486')?.alerts).toBe(4);
  });

  it('derives detectedOnly = detected - prevented and missed = executions - detected per technique and overall', async () => {
    mockSearch
      .mockResolvedValueOnce(resultsResponse(98, { prevented: 5, detected: 8 }, [
        { key: 'T1486', doc_count: 17, prevented: 5, detected: 8 },
      ]))
      .mockResolvedValueOnce(alertResponse({}));
    const res = await getTechniqueCoverage(client, opts());

    expect(res.byTechnique[0]).toMatchObject({ technique: 'T1486', executions: 17, prevented: 5, detectedOnly: 3, missed: 9 });
    expect(res.overall).toMatchObject({ executions: 98, prevented: 5, detectedOnly: 3, missed: 90 });
  });

  it('computes rates on distinct executions with 1 dp', async () => {
    mockSearch
      .mockResolvedValueOnce(resultsResponse(98, { prevented: 5, detected: 8 }, [
        // Rows can sum past the distinct total (multi-technique executions); rates ignore them.
        { key: 'T1486', doc_count: 60, prevented: 5, detected: 8 },
        { key: 'T1059', doc_count: 70, prevented: 5, detected: 8 },
      ]))
      .mockResolvedValueOnce(alertResponse({}));
    const res = await getTechniqueCoverage(client, opts());

    expect(res.overall.detectionRate).toBe(8.2);
    expect(res.overall.preventionRate).toBe(5.1);
    expect(res.overall.executions).toBe(98);
    expect(res.overall.testedTechniques).toBe(2);
    expect(res.overall.detectedTechniques).toBe(2);
  });

  it('accepts a numeric hits.total', async () => {
    const r = resultsResponse(0, { prevented: 1, detected: 2 }, []);
    mockSearch.mockResolvedValueOnce({ ...r, hits: { total: 10, hits: [] } });
    const res = await getTechniqueCoverage(client, opts());
    expect(res.overall).toMatchObject({ executions: 10, prevented: 1, detectedOnly: 1, missed: 8, detectionRate: 20 });
  });

  it('returns zeros, not NaN, for an empty window', async () => {
    mockSearch.mockResolvedValueOnce({ hits: { total: { value: 0, relation: 'eq' }, hits: [] }, aggregations: undefined });
    const res = await getTechniqueCoverage(client, opts());

    expect(res).toEqual({
      overall: {
        executions: 0, prevented: 0, detectedOnly: 0, missed: 0,
        detectionRate: 0, preventionRate: 0, testedTechniques: 0, detectedTechniques: 0,
      },
      byTechnique: [],
    });
    // No tested techniques → nothing to count alerts for.
    expect(mockSearch).toHaveBeenCalledTimes(1);
  });

  it('attaches alert counts and technique names', async () => {
    mockSearch
      .mockResolvedValueOnce(resultsResponse(3, { prevented: 0, detected: 1 }, [
        { key: 'T1486', doc_count: 2, prevented: 0, detected: 1 },
        { key: 'T9999', doc_count: 1, prevented: 0, detected: 0 },
      ]))
      .mockResolvedValueOnce(alertResponse({ T1486: 6 }));
    const res = await getTechniqueCoverage(client, opts());

    expect(res.byTechnique).toEqual([
      { technique: 'T1486', name: 'Data Encrypted for Impact', executions: 2, prevented: 0, detectedOnly: 1, missed: 1, alerts: 6 },
      { technique: 'T9999', name: null, executions: 1, prevented: 0, detectedOnly: 0, missed: 1, alerts: 0 },
    ]);
  });

  it('sorts detected techniques first, then by executions', async () => {
    mockSearch
      .mockResolvedValueOnce(resultsResponse(100, { prevented: 1, detected: 3 }, [
        { key: 'T1059', doc_count: 50, prevented: 0, detected: 0 },
        { key: 'T1003', doc_count: 5, prevented: 1, detected: 1 },
        { key: 'T1486', doc_count: 20, prevented: 0, detected: 2 },
        { key: 'T1105', doc_count: 30, prevented: 0, detected: 0 },
      ]))
      .mockResolvedValueOnce(alertResponse({}));
    const res = await getTechniqueCoverage(client, opts());

    expect(res.byTechnique.map((t) => t.technique)).toEqual(['T1486', 'T1003', 'T1059', 'T1105']);
  });

  it('defaults the window to the last 30 days', () => {
    const now = Date.parse('2026-10-20T12:00:00.000Z');
    expect(COVERAGE_DEFAULT_DAYS).toBe(30);
    expect(defaultCoverageWindow(now)).toEqual({ from: '2026-09-20T12:00:00.000Z', to: '2026-10-20T12:00:00.000Z' });
  });
});
