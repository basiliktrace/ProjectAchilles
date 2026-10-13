import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ──────────────────────────────────────────────────────

const mockSearch = vi.fn();

vi.mock('../../analytics/settings.js', () => ({
  SettingsService: class {
    getSettings = () => ({
      configured: true,
      connectionType: 'node',
      node: 'http://localhost:9200',
      indexPattern: 'achilles-results-*',
    });
  },
}));

vi.mock('../../analytics/client.js', () => ({
  createEsClient: () => ({
    search: mockSearch,
  }),
}));

vi.mock('../index-management.js', () => ({
  CROWDSTRIKE_INDEX: 'achilles-crowdstrike',
}));

const { CrowdStrikeAnalyticsService } = await import('../analytics.service.js');

// ── Tests ────────────────────────────────────────────────────────────

describe('CrowdStrikeAnalyticsService', () => {
  let service: InstanceType<typeof CrowdStrikeAnalyticsService>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new CrowdStrikeAnalyticsService();
  });

  // ── ZTA Score ────────────────────────────────────────────────

  describe('getZtaScoreSummary', () => {
    it('returns zero-state when no snapshot exists', async () => {
      mockSearch.mockResolvedValueOnce({ hits: { hits: [] } });

      const result = await service.getZtaScoreSummary();

      expect(result.overallScore).toBe(0);
      expect(result.deviceCount).toBe(0);
      expect(result.timestamp).toBeNull();
    });

    it('returns the latest zta_score document', async () => {
      mockSearch.mockResolvedValueOnce({
        hits: {
          hits: [{
            _source: {
              timestamp: '2026-10-01T06:00:00Z',
              overall_score: 72.5,
              os_score: 80,
              sensor_config_score: 65,
              device_count: 12,
              min_score: 40,
              max_score: 95,
            },
          }],
        },
      });

      const result = await service.getZtaScoreSummary();

      expect(result.overallScore).toBe(72.5);
      expect(result.osScore).toBe(80);
      expect(result.sensorConfigScore).toBe(65);
      expect(result.deviceCount).toBe(12);
      expect(result.minScore).toBe(40);
      expect(result.maxScore).toBe(95);
      expect(result.timestamp).toBe('2026-10-01T06:00:00Z');

      // Must query the zta_score doc_type on the crowdstrike index
      const query = mockSearch.mock.calls[0][0];
      expect(query.index).toBe('achilles-crowdstrike');
      expect(JSON.stringify(query.query)).toContain('zta_score');
    });
  });

  describe('getZtaScoreTrend', () => {
    it('returns trend points sorted by date', async () => {
      mockSearch.mockResolvedValueOnce({
        hits: {
          hits: [
            { _source: { timestamp: '2026-09-29T00:00:00Z', overall_score: 70, os_score: 75, sensor_config_score: 65, device_count: 10 } },
            { _source: { timestamp: '2026-09-30T00:00:00Z', overall_score: 72, os_score: 76, sensor_config_score: 66, device_count: 11 } },
          ],
        },
      });

      const result = await service.getZtaScoreTrend(30);

      expect(result).toHaveLength(2);
      expect(result[0].date).toBe('2026-09-29T00:00:00Z');
      expect(result[1].score).toBe(72);
      expect(result[1].deviceCount).toBe(11);
    });
  });

  // ── Alerts ─────────────────────────────────────────────────

  describe('getAlertSummary', () => {
    it('returns severity/status breakdown plus recent critical+high and medium alerts', async () => {
      // First call: aggregation query
      mockSearch.mockResolvedValueOnce({
        hits: { total: { value: 15 }, hits: [] },
        aggregations: {
          by_severity: {
            buckets: [
              { key: 'critical', doc_count: 2 },
              { key: 'high', doc_count: 3 },
              { key: 'medium', doc_count: 7 },
              { key: 'low', doc_count: 3 },
            ],
          },
          by_status: {
            buckets: [
              { key: 'new', doc_count: 8 },
              { key: 'closed', doc_count: 7 },
            ],
          },
        },
      });

      // Second call: recent critical+high alerts (Promise.all kicks these off in array order)
      mockSearch.mockResolvedValueOnce({
        hits: {
          hits: [
            { _source: { alert_id: 'a1', alert_title: 'Ransomware', severity: 'critical', created_at: '2026-10-01T10:00:00Z', service_source: 'CrowdStrike Falcon' } },
            { _source: { alert_id: 'a2', alert_title: 'Credential dumping', severity: 'high', created_at: '2026-10-01T09:00:00Z', service_source: 'CrowdStrike Falcon' } },
          ],
        },
      });

      // Third call: recent medium alerts
      mockSearch.mockResolvedValueOnce({
        hits: {
          hits: [
            { _source: { alert_id: 'b1', alert_title: 'Suspicious macro', severity: 'medium', created_at: '2026-10-01T08:00:00Z', service_source: 'CrowdStrike Falcon' } },
          ],
        },
      });

      const result = await service.getAlertSummary();

      expect(result.total).toBe(15);
      expect(result.bySeverity.critical).toBe(2);
      expect(result.bySeverity.high).toBe(3);
      expect(result.byStatus.new).toBe(8);
      expect(result.recentHigh).toHaveLength(2);
      expect(result.recentHigh[0].title).toBe('Ransomware');
      expect(result.recentMedium).toHaveLength(1);
      expect(result.recentMedium[0].severity).toBe('medium');

      // The "recentHigh" query must cover BOTH critical and high severities
      const recentHighQuery = mockSearch.mock.calls[1][0];
      expect(JSON.stringify(recentHighQuery.query)).toContain('critical');
      expect(JSON.stringify(recentHighQuery.query)).toContain('high');
    });
  });

  describe('getAlerts', () => {
    it('applies severity/status/search filters and pagination', async () => {
      mockSearch.mockResolvedValueOnce({
        hits: {
          total: { value: 1 },
          hits: [{
            _source: {
              alert_id: 'a1',
              alert_title: 'Ransomware note dropped',
              description: '...',
              severity: 'critical',
              status: 'new',
              category: 'ransomware',
              service_source: 'CrowdStrike Falcon',
              mitre_techniques: ['T1486'],
              created_at: '2026-10-01T10:00:00Z',
              updated_at: '2026-10-01T10:05:00Z',
              resolved_at: null,
              recommended_actions: '',
              f0rtika: { auto_resolved: true, auto_resolved_at: '2026-10-01T11:00:00Z', auto_resolve_mode: 'enabled' },
            },
          }],
        },
      });

      const result = await service.getAlerts({
        page: 2, pageSize: 10, severity: 'critical', status: 'new', search: 'ransomware',
      });

      const query = mockSearch.mock.calls[0][0];
      expect(query.from).toBe(10);
      expect(query.size).toBe(10);
      const must = query.query.bool.must;
      expect(must).toContainEqual({ term: { severity: 'critical' } });
      expect(must).toContainEqual({ term: { status: 'new' } });

      expect(result.total).toBe(1);
      expect(result.data[0].severity).toBe('critical');
      expect(result.data[0].auto_resolved).toBe(true);
      expect(result.data[0].auto_resolve_mode).toBe('enabled');
    });

    it('OR-filters techniques with sub-technique prefix matching', async () => {
      mockSearch.mockResolvedValueOnce({ hits: { total: { value: 0 }, hits: [] } });

      await service.getAlerts({ techniques: ['T1059', 'T1486'] });

      const must = mockSearch.mock.calls[0][0].query.bool.must;
      const techClause = must.find((c: any) => c.bool?.should);
      expect(techClause.bool.should).toContainEqual({ term: { mitre_techniques: 'T1059' } });
      expect(techClause.bool.should).toContainEqual({ prefix: { mitre_techniques: 'T1059.' } });
      expect(techClause.bool.should).toContainEqual({ prefix: { mitre_techniques: 'T1486.' } });
    });
  });

  describe('getAlertTrend', () => {
    it('returns daily buckets with critical/high/medium/low sub-counts', async () => {
      mockSearch.mockResolvedValueOnce({
        hits: { total: { value: 6 }, hits: [] },
        aggregations: {
          by_day: {
            buckets: [
              {
                key_as_string: '2026-09-30T00:00:00.000Z',
                doc_count: 4,
                critical: { doc_count: 1 },
                high: { doc_count: 1 },
                medium: { doc_count: 2 },
                low: { doc_count: 0 },
              },
              {
                key_as_string: '2026-10-01T00:00:00.000Z',
                doc_count: 2,
                critical: { doc_count: 0 },
                high: { doc_count: 1 },
                medium: { doc_count: 0 },
                low: { doc_count: 1 },
              },
            ],
          },
        },
      });

      const result = await service.getAlertTrend(30);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ count: 4, critical: 1, high: 1, medium: 2, low: 0 });
      expect(result[1]).toMatchObject({ count: 2, critical: 0, high: 1, medium: 0, low: 1 });
    });
  });

  // ── Technique overlap ────────────────────────────────────────

  describe('getTechniqueOverlap', () => {
    it('returns only techniques present in BOTH test results and alerts', async () => {
      // Test-side aggregation
      mockSearch.mockResolvedValueOnce({
        aggregations: {
          techniques: {
            buckets: [
              { key: 'T1059', doc_count: 10 },
              { key: 'T1003', doc_count: 5 },
            ],
          },
        },
      });
      // Alert-side aggregation
      mockSearch.mockResolvedValueOnce({
        aggregations: {
          techniques: {
            buckets: [
              { key: 'T1059', doc_count: 3 },
              { key: 'T1486', doc_count: 2 },
            ],
          },
        },
      });

      const result = await service.getTechniqueOverlap();

      // T1059 overlaps; T1003 has no alerts; T1486 has no tests
      expect(result).toEqual([
        { technique: 'T1059', testResults: 10, crowdstrikeAlerts: 3 },
      ]);
    });
  });

  // ── Detection rate ───────────────────────────────────────────

  describe('getDetectionRate', () => {
    it('computes per-technique detection within the time window, with sub→parent roll-up', async () => {
      const baseHour = Date.parse('2026-09-30T10:00:00Z');

      // Test executions: T1059 at baseHour (2 execs), T1574.002 (sub-technique) at baseHour (1 exec)
      mockSearch.mockResolvedValueOnce({
        aggregations: {
          techniques: {
            buckets: [
              { key: 'T1059', doc_count: 2, by_hour: { buckets: [{ key: baseHour, doc_count: 2 }] } },
              { key: 'T1574.002', doc_count: 1, by_hour: { buckets: [{ key: baseHour, doc_count: 1 }] } },
            ],
          },
        },
      });

      // Alerts: T1059 at baseHour; T1574 (PARENT only — rolls up to T1574.002)
      mockSearch.mockResolvedValueOnce({
        aggregations: {
          techniques: {
            buckets: [
              { key: 'T1059', doc_count: 1, by_hour: { buckets: [{ key: baseHour, doc_count: 1 }] } },
              { key: 'T1574', doc_count: 1, by_hour: { buckets: [{ key: baseHour, doc_count: 1 }] } },
            ],
          },
        },
      });

      const result = await service.getDetectionRate(30, 60);

      expect(result.overall.totalExecutions).toBe(3);
      expect(result.overall.correlatedExecutions).toBe(3);
      expect(result.overall.detectionRate).toBe(100);
      expect(result.overall.testedTechniques).toBe(2);
      expect(result.overall.detectedTechniques).toBe(2);

      const sub = result.byTechnique.find((t) => t.technique === 'T1574.002');
      expect(sub?.detected).toBe(true); // credited via parent roll-up
    });

    it('does NOT credit a parent test from a sub-technique alert (one-directional roll-up)', async () => {
      const baseHour = Date.parse('2026-09-30T10:00:00Z');

      // Test executions: parent T1574 only
      mockSearch.mockResolvedValueOnce({
        aggregations: {
          techniques: {
            buckets: [
              { key: 'T1574', doc_count: 1, by_hour: { buckets: [{ key: baseHour, doc_count: 1 }] } },
            ],
          },
        },
      });

      // Alerts: sub-technique T1574.002 only — must NOT roll up to the parent test
      mockSearch.mockResolvedValueOnce({
        aggregations: {
          techniques: {
            buckets: [
              { key: 'T1574.002', doc_count: 1, by_hour: { buckets: [{ key: baseHour, doc_count: 1 }] } },
            ],
          },
        },
      });

      const result = await service.getDetectionRate(30, 60);

      expect(result.overall.correlatedExecutions).toBe(0);
      expect(result.overall.detectionRate).toBe(0);
      expect(result.byTechnique[0].detected).toBe(false);
    });
  });

  // ── Score comparison (ZTA vs defense) ────────────────────────

  describe('getScoreComparison', () => {
    it('merges ZTA score and defense-score series by date', async () => {
      // ZTA trend (getZtaScoreTrend call)
      mockSearch.mockResolvedValueOnce({
        hits: {
          hits: [
            { _source: { timestamp: '2026-09-30T06:00:00Z', overall_score: 72, os_score: 75, sensor_config_score: 65, device_count: 10 } },
          ],
        },
      });
      // Defense score aggregation
      mockSearch.mockResolvedValueOnce({
        aggregations: {
          by_day: {
            buckets: [
              { key_as_string: '2026-09-30T00:00:00.000Z', doc_count: 4, protected: { doc_count: 3 } },
            ],
          },
        },
      });

      const result = await service.getScoreComparison(90);

      expect(result).toHaveLength(1);
      expect(result[0].date).toBe('2026-09-30');
      expect(result[0].ztaScore).toBe(72);
      expect(result[0].defenseScore).toBe(75);
    });
  });

  // ── Alerts for test (3-tier fallback) ────────────────────────

  describe('getAlertsForTest', () => {
    const alertHit = (overrides: Record<string, unknown> = {}) => ({
      _source: {
        alert_id: 'alert-1',
        alert_title: 'Stage binary executed',
        description: '',
        severity: 'high',
        status: 'new',
        category: 'suspicious_activity',
        service_source: 'CrowdStrike Falcon',
        mitre_techniques: ['T1059'],
        created_at: '2026-10-01T12:01:00Z',
        updated_at: '2026-10-01T12:01:00Z',
        resolved_at: null,
        recommended_actions: '',
        evidence_filenames: ['92b0b4f6-a09b-4c7b-b593-31ce461f804c-t1059.exe'],
        ...overrides,
      },
    });

    const baseParams = {
      techniques: ['T1059'],
      timestamp: '2026-10-01T12:00:00Z',
      windowMinutes: 30,
      hostname: 'LT-TPL-L50',
      binaryName: '92b0b4f6-a09b-4c7b-b593-31ce461f804c.exe',
    };

    it('tier 1: evidence-based match with stage attribution', async () => {
      mockSearch.mockResolvedValueOnce({
        hits: { total: { value: 1 }, hits: [alertHit()] },
      });

      const result = await service.getAlertsForTest(
        baseParams.techniques, baseParams.timestamp, baseParams.windowMinutes,
        baseParams.hostname, baseParams.binaryName,
      );

      expect(result.total).toBe(1);
      expect(result.alerts[0].attribution).toBe('stage');
      expect(result.alerts[0].attributed_control_id).toBe('t1059');
      expect(result.matchedTechniques).toContain('T1059');
      // Only ONE search — the evidence tier hit, fallbacks not needed
      expect(mockSearch).toHaveBeenCalledTimes(1);
    });

    it('tier 2: falls back to technique+hostname when evidence query matches nothing', async () => {
      // Evidence tier: no hits
      mockSearch.mockResolvedValueOnce({ hits: { total: { value: 0 }, hits: [] } });
      // Hostname+technique tier: one hit (no stage binary in evidence → bundle attribution)
      mockSearch.mockResolvedValueOnce({
        hits: { total: { value: 1 }, hits: [alertHit({ evidence_filenames: ['92b0b4f6-a09b-4c7b-b593-31ce461f804c.exe'] })] },
      });

      const result = await service.getAlertsForTest(
        baseParams.techniques, baseParams.timestamp, baseParams.windowMinutes,
        baseParams.hostname, baseParams.binaryName,
      );

      expect(result.total).toBe(1);
      // Orchestrator UUID-only binary → bundle attribution
      expect(result.alerts[0].attribution).toBe('bundle');
      expect(result.alerts[0].attributed_control_id).toBeUndefined();
      expect(mockSearch).toHaveBeenCalledTimes(2);
    });

    it('tier 3: technique-only fallback when no hostname is provided', async () => {
      mockSearch.mockResolvedValueOnce({
        hits: { total: { value: 1 }, hits: [alertHit()] },
      });

      const result = await service.getAlertsForTest(
        baseParams.techniques, baseParams.timestamp, baseParams.windowMinutes,
      );

      expect(result.total).toBe(1);
      // No binaryName → no discriminator → bundle attribution
      expect(result.alerts[0].attribution).toBe('bundle');
      expect(mockSearch).toHaveBeenCalledTimes(1);

      // The technique-only query must still carry the time window — and, with
      // no hostname parameter, NO evidence_hostnames constraint.
      const query = mockSearch.mock.calls[0][0];
      expect(JSON.stringify(query.query)).toContain('mitre_techniques');
      expect(JSON.stringify(query.query)).toContain('timestamp');
      expect(JSON.stringify(query.query)).not.toContain('evidence_hostnames');
    });

    it('tier 3 WITH hostname keeps the evidence_hostnames constraint (no cross-host associations)', async () => {
      // Fleet-wide simultaneous runs: without the host filter, a host whose
      // EDR stayed quiet would inherit sibling hosts' same-technique alerts
      // in the shared time window (observed in production).
      // Evidence tier (binaryName+hostname) misses; technique+hostname tier
      // misses; tier 3 must STILL be host-scoped.
      mockSearch.mockResolvedValueOnce({ hits: { total: { value: 0 }, hits: [] } }); // tier 1
      mockSearch.mockResolvedValueOnce({ hits: { total: { value: 0 }, hits: [] } }); // tier 2
      mockSearch.mockResolvedValueOnce({
        hits: { total: { value: 1 }, hits: [alertHit()] },
      }); // tier 3

      const result = await service.getAlertsForTest(
        baseParams.techniques, baseParams.timestamp, baseParams.windowMinutes,
        baseParams.hostname, baseParams.binaryName,
      );

      expect(result.total).toBe(1);
      expect(mockSearch).toHaveBeenCalledTimes(3);
      const tier3 = JSON.stringify(mockSearch.mock.calls[2][0].query);
      expect(tier3).toContain('mitre_techniques');
      expect(tier3).toContain('evidence_hostnames');
      expect(tier3).toContain('LT-TPL-L50');
    });

    it('tier 3 with hostname but no binaryName (evidence tier skipped) is host-scoped', async () => {
      // Technique+hostname tier misses → tier 3 runs with the hostname filter.
      mockSearch.mockResolvedValueOnce({ hits: { total: { value: 0 }, hits: [] } }); // tier 2
      mockSearch.mockResolvedValueOnce({
        hits: { total: { value: 1 }, hits: [alertHit()] },
      }); // tier 3

      const result = await service.getAlertsForTest(
        baseParams.techniques, baseParams.timestamp, baseParams.windowMinutes,
        baseParams.hostname,
      );

      expect(result.total).toBe(1);
      expect(mockSearch).toHaveBeenCalledTimes(2);
      const tier3 = JSON.stringify(mockSearch.mock.calls[1][0].query);
      expect(tier3).toContain('evidence_hostnames');
      expect(tier3).toContain('LT-TPL-L50');
    });

    it('sorts multiple alerts by proximity to the test timestamp', async () => {
      mockSearch.mockResolvedValueOnce({
        hits: {
          total: { value: 2 },
          hits: [
            alertHit({ alert_id: 'far', created_at: '2026-10-01T12:20:00Z' }),
            alertHit({ alert_id: 'near', created_at: '2026-10-01T12:02:00Z' }),
          ],
        },
      });

      const result = await service.getAlertsForTest(
        baseParams.techniques, baseParams.timestamp, baseParams.windowMinutes,
      );

      expect(result.alerts[0].alert_id).toBe('near');
      expect(result.alerts[1].alert_id).toBe('far');
    });
  });
});
