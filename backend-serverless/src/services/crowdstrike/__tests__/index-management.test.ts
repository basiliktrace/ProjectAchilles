// Mirrors backend/src/services/crowdstrike/__tests__/index-management.test.ts.
// Fork difference: the serverless SettingsService.getSettings() is async (Blob).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSettings = vi.fn();
vi.mock('../../analytics/settings.js', () => ({
  SettingsService: class {
    getSettings = mockGetSettings;
  },
}));

const mockIndicesCreate = vi.fn();
const mockCatIndices = vi.fn();
const mockIndicesExists = vi.fn();
const mockPutMapping = vi.fn();

vi.mock('../../analytics/client.js', () => ({
  createEsClient: () => ({
    indices: {
      create: mockIndicesCreate,
      exists: mockIndicesExists,
      putMapping: mockPutMapping,
    },
    cat: { indices: mockCatIndices },
  }),
}));

const {
  createCrowdStrikeIndex,
  ensureCrowdStrikeIndex,
  listCrowdStrikeIndices,
  ensureCrowdStrikeIndexMappings,
  CROWDSTRIKE_INDEX,
  CROWDSTRIKE_INDEX_MAPPING,
} = await import('../index-management.js');

describe('CrowdStrike index management (serverless)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSettings.mockResolvedValue({
      configured: true,
      connectionType: 'node',
      node: 'http://localhost:9200',
    });
  });

  describe('createCrowdStrikeIndex', () => {
    it('creates the index successfully', async () => {
      mockIndicesCreate.mockResolvedValue({ acknowledged: true });

      const result = await createCrowdStrikeIndex();
      expect(result.created).toBe(true);
      expect(result.message).toContain(CROWDSTRIKE_INDEX);
      expect(mockIndicesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ index: CROWDSTRIKE_INDEX }),
      );
    });

    it('returns false if index already exists (400)', async () => {
      mockIndicesCreate.mockRejectedValue({ statusCode: 400 });

      const result = await createCrowdStrikeIndex();
      expect(result.created).toBe(false);
      expect(result.message).toContain('already exists');
    });

    it('throws on ES not configured', async () => {
      mockGetSettings.mockResolvedValue({ configured: false });

      await expect(createCrowdStrikeIndex()).rejects.toThrow('not configured');
    });

    it('re-throws unexpected errors', async () => {
      mockIndicesCreate.mockRejectedValue(new Error('cluster down'));

      await expect(createCrowdStrikeIndex()).rejects.toThrow('cluster down');
    });
  });

  describe('ensureCrowdStrikeIndex', () => {
    it('does not attempt to create an index that already exists', async () => {
      // A least-privilege API key (read/write on the index, no create_index)
      // gets a 403 from indices.create even when the index exists — ES checks
      // privileges before existence. That 403 used to abort every sync.
      mockIndicesExists.mockResolvedValueOnce(true);
      mockIndicesCreate.mockRejectedValue({ statusCode: 403 });

      await expect(ensureCrowdStrikeIndex()).resolves.toBeUndefined();
      expect(mockIndicesCreate).not.toHaveBeenCalled();
    });

    it('creates the index when it is missing', async () => {
      mockIndicesExists.mockResolvedValueOnce(false);
      mockIndicesCreate.mockResolvedValueOnce({ acknowledged: true });

      await ensureCrowdStrikeIndex();
      expect(mockIndicesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ index: CROWDSTRIKE_INDEX }),
      );
    });

    it('tolerates a create race (400 already exists)', async () => {
      mockIndicesExists.mockResolvedValueOnce(false);
      mockIndicesCreate.mockRejectedValueOnce({ statusCode: 400 });

      await expect(ensureCrowdStrikeIndex()).resolves.toBeUndefined();
    });
  });

  describe('CROWDSTRIKE_INDEX_MAPPING', () => {
    it('declares the doc_type discriminator and zta_score fields', () => {
      const props = CROWDSTRIKE_INDEX_MAPPING.mappings.properties as Record<string, any>;
      expect(props.doc_type.type).toBe('keyword');
      expect(props.overall_score.type).toBe('float');
      expect(props.os_score.type).toBe('float');
      expect(props.sensor_config_score.type).toBe('float');
      expect(props.device_count.type).toBe('integer');
      expect(props.min_score.type).toBe('float');
      expect(props.max_score.type).toBe('float');
    });

    it('includes f0rtika sub-object with correlation + auto-resolve fields', () => {
      const props = CROWDSTRIKE_INDEX_MAPPING.mappings.properties as Record<string, any>;
      expect(props.f0rtika).toBeDefined();
      expect(props.f0rtika.properties.achilles_correlated.type).toBe('boolean');
      expect(props.f0rtika.properties.achilles_test_uuid.type).toBe('keyword');
      expect(props.f0rtika.properties.achilles_matched_at.type).toBe('date');
      expect(props.f0rtika.properties.auto_resolved.type).toBe('boolean');
      expect(props.f0rtika.properties.auto_resolved_at.type).toBe('date');
      expect(props.f0rtika.properties.auto_resolve_mode.type).toBe('keyword');
      expect(props.f0rtika.properties.auto_resolve_error.type).toBe('keyword');
    });

    it('uses text+keyword multi-fields for evidence arrays', () => {
      const props = CROWDSTRIKE_INDEX_MAPPING.mappings.properties as Record<string, any>;
      for (const field of ['evidence_hostnames', 'evidence_filenames']) {
        expect(props[field].type).toBe('text');
        expect(props[field].fields.keyword.type).toBe('keyword');
        expect(props[field].fields.keyword.ignore_above).toBe(256);
      }
      expect(props.evidence_filepaths.type).toBe('text');
      expect(props.evidence_filepaths.fields.keyword.ignore_above).toBe(1024);
    });

    it('has no control-profile fields (CrowdStrike has no Secure Score control equivalent)', () => {
      const props = CROWDSTRIKE_INDEX_MAPPING.mappings.properties as Record<string, any>;
      expect(props.control_scores).toBeUndefined();
      expect(props.control_name).toBeUndefined();
      expect(props.control_category).toBeUndefined();
    });
  });

  describe('ensureCrowdStrikeIndexMappings', () => {
    it('calls putMapping when the index exists', async () => {
      mockIndicesExists.mockResolvedValueOnce(true);
      mockPutMapping.mockResolvedValueOnce({ acknowledged: true });

      await ensureCrowdStrikeIndexMappings();

      expect(mockPutMapping).toHaveBeenCalledWith(
        expect.objectContaining({
          index: CROWDSTRIKE_INDEX,
          properties: expect.any(Object),
        }),
      );
    });

    it('skips putMapping when the index does not exist', async () => {
      mockIndicesExists.mockResolvedValueOnce(false);

      await ensureCrowdStrikeIndexMappings();

      expect(mockPutMapping).not.toHaveBeenCalled();
    });

    it('no-ops when Elasticsearch is not configured', async () => {
      mockGetSettings.mockResolvedValue({ configured: false });

      await ensureCrowdStrikeIndexMappings();

      expect(mockIndicesExists).not.toHaveBeenCalled();
      expect(mockPutMapping).not.toHaveBeenCalled();
    });

    it('swallows transient errors without throwing', async () => {
      mockIndicesExists.mockRejectedValueOnce(new Error('cluster transient'));

      await expect(ensureCrowdStrikeIndexMappings()).resolves.toBeUndefined();
    });
  });

  describe('listCrowdStrikeIndices', () => {
    it('returns index info', async () => {
      mockCatIndices.mockResolvedValue([
        { index: CROWDSTRIKE_INDEX, 'docs.count': '42', 'store.size': '1024', health: 'green' },
      ]);

      const indices = await listCrowdStrikeIndices();
      expect(indices).toHaveLength(1);
      expect(indices[0].name).toBe(CROWDSTRIKE_INDEX);
      expect(indices[0].docsCount).toBe(42);
    });

    it('returns empty array on 404', async () => {
      mockCatIndices.mockRejectedValue({ statusCode: 404 });

      const indices = await listCrowdStrikeIndices();
      expect(indices).toEqual([]);
    });
  });
});
