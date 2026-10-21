import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import { resolveTestNames } from '../test-name-lookup.js';

const mockSearch = vi.fn();
const client = { search: mockSearch } as unknown as Client;

const bucket = (key: string, field: string, value: string) => ({
  key,
  top: { hits: { hits: [{ _source: { f0rtika: { [field]: value } } }] } },
});

describe('resolveTestNames', () => {
  beforeEach(() => mockSearch.mockReset());

  it('maps bundle_id hits to bundle_name (kind bundle) and test_uuid hits to test_name (kind test)', async () => {
    mockSearch.mockResolvedValue({
      aggregations: {
        by_test: { buckets: [bucket('t1', 'test_name', 'Test One'), bucket('b1', 'test_name', 'Control Name')] },
        by_bundle: { buckets: [bucket('b1', 'bundle_name', 'Bundle One')] },
      },
    });
    const m = await resolveTestNames(client, 'achilles-results-*', ['t1', 'b1']);
    expect(m.get('t1')).toEqual({ name: 'Test One', kind: 'test' });
    expect(m.get('b1')).toEqual({ name: 'Bundle One', kind: 'bundle' });
    expect(mockSearch).toHaveBeenCalledTimes(1);
  });

  it('restricts both terms aggs to the requested uuids so composite bundle keys cannot crowd them out', async () => {
    mockSearch.mockResolvedValue({ aggregations: {} });
    await resolveTestNames(client, 'achilles-results-*', ['t1', 'b1']);
    const req = mockSearch.mock.calls[0][0];
    expect(req.aggs.by_test.terms).toEqual({ field: 'f0rtika.test_uuid', size: 2, include: ['t1', 'b1'] });
    expect(req.aggs.by_bundle.terms).toEqual({ field: 'f0rtika.bundle_id', size: 2, include: ['t1', 'b1'] });
  });

  it('returns an empty map when search rejects', async () => {
    mockSearch.mockRejectedValueOnce(new Error('boom'));
    const m = await resolveTestNames(client, 'idx', ['t1']);
    expect(m.size).toBe(0);
  });

  it('skips the request for an empty uuid list', async () => {
    const m = await resolveTestNames(client, 'idx', []);
    expect(m.size).toBe(0);
    expect(mockSearch).not.toHaveBeenCalled();
  });
});
