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

  it('maps bundle_id hits to bundle_name and test_uuid hits to test_name', async () => {
    mockSearch.mockResolvedValue({
      aggregations: {
        by_test: { buckets: [bucket('t1', 'test_name', 'Test One'), bucket('b1', 'test_name', 'Control Name')] },
        by_bundle: { buckets: [bucket('b1', 'bundle_name', 'Bundle One')] },
      },
    });
    const m = await resolveTestNames(client, 'achilles-results-*', ['t1', 'b1']);
    expect(m.get('t1')).toBe('Test One');
    expect(m.get('b1')).toBe('Bundle One');
    expect(mockSearch).toHaveBeenCalledTimes(1);
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
