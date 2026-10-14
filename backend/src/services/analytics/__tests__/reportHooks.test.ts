import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AnalyticsSettings } from '../../../types/analytics.js';

const mockSearch = vi.fn();
const mockCount = vi.fn();

vi.mock('@elastic/elasticsearch', () => ({
  Client: vi.fn().mockImplementation(function (this: any) {
    this.search = mockSearch;
    this.count = mockCount;
  }),
}));

const { ElasticsearchService, RUN_GROUP_KEY_SCRIPT, TEST_KEY_SCRIPT } = await import('../elasticsearch.js');

const settings: AnalyticsSettings = {
  connectionType: 'direct',
  node: 'http://localhost:9200',
  apiKey: 'k',
  indexPattern: 'achilles-results-*',
  configured: true,
};

describe('execution report hooks on ElasticsearchService', () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockCount.mockReset();
  });

  it('buildExtendedFilters is public and composes base, org and filter-bar clauses', () => {
    const service = new ElasticsearchService(settings);
    const filters = service.buildExtendedFilters({
      org: 'org-1',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-13T00:00:00.000Z',
      hostnames: 'H1',
      result: 'unprotected',
    });
    expect(filters).toContainEqual({ range: { 'routing.event_time': { gte: '2026-10-01T00:00:00.000Z', lte: '2026-10-13T00:00:00.000Z' } } });
    expect(filters).toContainEqual({ term: { 'routing.oid': 'org-1' } });
    expect(filters).toContainEqual({ term: { 'event.ERROR': 101 } });
    expect(filters).toContainEqual({ term: { 'routing.hostname': 'H1' } });
  });

  it('grouped executions use the shared RUN_GROUP_KEY_SCRIPT', async () => {
    mockCount.mockResolvedValue({ count: 0 });
    mockSearch.mockResolvedValue({ aggregations: { total_groups: { value: 0 }, display_groups: { buckets: [] } } });
    await new ElasticsearchService(settings).getGroupedPaginatedExecutions({ page: 1, pageSize: 25 });
    const aggs = mockSearch.mock.calls[0][0].aggs;
    expect(aggs.display_groups.terms.script).toBe(RUN_GROUP_KEY_SCRIPT);
    expect(aggs.total_groups.cardinality.script).toBe(RUN_GROUP_KEY_SCRIPT);
  });

  it('TEST_KEY_SCRIPT falls back to test_uuid when a bundle doc lacks bundle_id', () => {
    expect(TEST_KEY_SCRIPT.lang).toBe('painless');
    expect(TEST_KEY_SCRIPT.source).toContain("doc.containsKey('f0rtika.bundle_id')");
    expect(TEST_KEY_SCRIPT.source).toContain("doc['f0rtika.bundle_id'].size() > 0");
    expect(TEST_KEY_SCRIPT.source).toContain("return doc['f0rtika.test_uuid'].value");
  });
});
