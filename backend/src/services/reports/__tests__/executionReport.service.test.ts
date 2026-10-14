import { describe, it, expect, vi } from 'vitest';
import { STAGE_OUTCOMES } from '../stageOutcome.js';
import { ExecutionReportService } from '../executionReport.service.js';
import type { OutcomeCounts } from '../../../types/reports.js';
import type { AnalyticsSettings } from '../../../types/analytics.js';

const BUNDLE = '298cc137-ea39-4cf0-9b2d-b1c59a3cbacb';
const TASK = '4c28f408-1676-40ff-a2e6-60ea5bdd6076';
const NOW = new Date('2026-10-13T23:40:00.000Z');
const T_RUN = Date.parse('2026-10-12T12:47:49.000Z');
const settings: AnalyticsSettings = { connectionType: 'direct', node: 'http://localhost:9200', indexPattern: 'achilles-results-*', configured: true };

const agg = (c: Partial<OutcomeCounts>) => ({ buckets: Object.fromEntries(STAGE_OUTCOMES.map((k) => [k, { doc_count: c[k] ?? 0 }])) });

function scopeResponse(over: { outcomes?: Partial<OutcomeCounts>; runs?: number } = {}) {
  return { aggregations: {
    outcomes: agg(over.outcomes ?? { protected: 1, unprotected: 1 }),
    runs: { value: over.runs ?? 1 }, endpoints: { value: 1 }, tests: { value: 1 }, tactics: { value: 2 },
    first: { value: T_RUN }, last: { value: T_RUN }, high_impact: { doc_count: 1 },
    hosts: { buckets: [{ key: 'WS-FIN-014', runs: { value: 1 }, outcomes: agg({ protected: 1, unprotected: 1 }) }] },
    techniques: { buckets: [
      { key: 'T1567.002', tactics: { buckets: [{ key: 'exfiltration' }] }, tests: { buckets: [{ key: BUNDLE }] }, outcomes: agg({ unprotected: 4 }) },
      { key: 'T1486', tactics: { buckets: [{ key: 'impact' }] }, tests: { buckets: [{ key: BUNDLE }] }, outcomes: agg({ protected: 4 }) },
    ] },
    actors: { buckets: [{ key: 'LockBit 3.0 (S1202)', runs: { value: 1 }, tests: { buckets: [{ key: BUNDLE }] }, outcomes: agg({ protected: 1, unprotected: 1 }) }] },
  } };
}

const stageBucket = (controlId: string, validator: string, name: string, tactic: string, c: Partial<OutcomeCounts>) => ({
  key: controlId, outcomes: agg(c),
  meta: { hits: { hits: [{ _source: { f0rtika: { test_name: name, control_validator: validator, techniques: [controlId], tactics: [tactic] } } }] } },
});

function testsResponse() {
  return { aggregations: { tests: { buckets: [{
    key: BUNDLE, runs: { value: 1 }, endpoints: { value: 1 }, last_run: { value: T_RUN }, outcomes: agg({ protected: 1, unprotected: 1 }),
    meta: { hits: { hits: [{ _source: { f0rtika: {
      is_bundle_control: true, bundle_name: 'LockBit 3.0 Double Extortion Kill Chain', test_name: 'Impact',
      category: 'intel-driven', severity: 'critical', threat_actor: 'LockBit 3.0 (S1202)',
    } } }] } },
    stages: { buckets: [
      stageBucket('T1486', 'Stage 5', 'Impact', 'impact', { protected: 1 }),
      stageBucket('T1567.002', 'Stage 4', 'Pre-encryption exfiltration', 'exfiltration', { unprotected: 1 }),
    ] },
  }] } } };
}

const memberHit = (controlId: string, validator: string, exit: number, tactic: string) => ({
  _id: `${TASK}::${controlId}`,
  _source: {
    event: { ERROR: exit }, routing: { hostname: 'WS-FIN-014' },
    f0rtika: {
      is_bundle_control: true, bundle_id: BUNDLE, bundle_name: 'LockBit 3.0 Double Extortion Kill Chain', control_id: controlId,
      control_validator: validator, test_name: controlId, techniques: [controlId], tactics: [tactic],
    },
  },
});

function runsResponse() {
  return { aggregations: { runs: { buckets: [{
    key: `bundle::${BUNDLE}::WS-FIN-014::${T_RUN}`, doc_count: 2, completed: { value: T_RUN },
    members: { hits: { hits: [memberHit('T1486', 'Stage 5', 126, 'impact'), memberHit('T1567.002', 'Stage 4', 101, 'exfiltration')] } },
  }] } } };
}

function timelineResponse() {
  return { aggregations: { timeline: { buckets: [{
    key: Date.parse('2026-10-12T04:00:00.000Z'),
    lanes: { buckets: { [BUNDLE]: { doc_count: 2, runs: { value: 1 }, outcomes: agg({ protected: 1, unprotected: 1 }) }, __other__: { doc_count: 0 } } },
  }] } } };
}

function routeSearch(scope: object = scopeResponse()) {
  return async (req: { aggs: Record<string, any> }) => {
    if (req.aggs.hosts) return scope;
    if (req.aggs.timeline) return timelineResponse();
    if (req.aggs.runs?.terms) return runsResponse();
    return testsResponse();
  };
}

const alertHit = (title: string) => ({ hits: { hits: [{ _source: {
  alert_title: title, severity: 'high', status: 'new', created_at: '2026-10-12T12:48:51Z',
  evidence_filenames: [`${BUNDLE}-T1567.002.exe`],
} }] } });

/** msearch stub: one hit per sub-search, answering for whichever vendor index it targets. */
const msearchHits = (titleByIndex: Record<string, string>) => async ({ searches }: { searches: { index?: string }[] }) => ({
  responses: Array.from({ length: searches.length / 2 }, (_, i) => alertHit(titleByIndex[searches[i * 2].index ?? ''] ?? 'Alert')),
});

function makeDeps(over: Record<string, unknown> = {}): any {
  return {
    client: {
      search: vi.fn(routeSearch()),
      msearch: vi.fn(msearchHits({ 'achilles-defender': 'RcloneExfiltration' })),
    },
    es: {
      buildExtendedFilters: vi.fn(() => [{ match_all: {} }]),
      getDefenseScore: vi.fn(async () => ({
        score: 61.5, rawScore: 58, riskAcceptedCount: 3, totalExecutions: 40,
        protectedCount: 20, detectedCount: 4, unprotectedCount: 16, realScore: 50,
      })),
    },
    vendors: { defender: true, crowdstrike: false },
    getTestMetadata: vi.fn(() => ({
      uuid: BUNDLE, name: 'LockBit', description: 'Emulates the LockBit 3.0 playbook.', techniques: [],
      isMultiStage: true, stages: [], threatActor: 'LockBit 3.0 (S1202)', score: 8.8,
    })),
    readGuidance: vi.fn(() => '| [T1567.002](x) — Exfiltration to Cloud Storage | Exfiltration | [M1021](y) Restrict Web-Based Content |'),
    getRunStartTimes: vi.fn(async () => new Map([[TASK, '2026-10-12T12:41:06.000Z']])),
    getAcceptances: vi.fn(async () => ({})),
    budgetMs: 5_000,
    vendorBudgetMs: 5_000,
    ...over,
  };
}

const params = (over: Record<string, unknown> = {}) =>
  ({ from: 'now-30d', tz: 'America/Santo_Domingo', includeAcceptedRisks: false, ...over }) as any;

describe('ExecutionReportService.generate', () => {
  it('resolves the window once and passes absolute bounds to every query', async () => {
    const deps = makeDeps();
    await new ExecutionReportService(settings, deps).generate(params({ hostnames: 'WS-FIN-014' }), NOW);
    const scope = { hostnames: 'WS-FIN-014', from: '2026-09-13T23:40:00.000Z', to: '2026-10-13T23:40:00.000Z' };
    expect(deps.es.buildExtendedFilters).toHaveBeenCalledWith(scope);
    expect(deps.es.getDefenseScore).toHaveBeenCalledWith({ ...scope, scoringMode: 'any-stage' });
    for (const [req] of deps.client.search.mock.calls) expect(req.index).toBe('achilles-results-*');
  });

  it('assembles the report', async () => {
    const report = await new ExecutionReportService(settings, makeDeps()).generate(params(), NOW);

    expect(report.meta.window).toMatchObject({ preset: '30d', label: 'Last 30 days', bucket: 'day', firstExecution: '2026-10-12T12:47:49.000Z' });
    expect(report.meta.tz).toBe('America/Santo_Domingo');
    expect(report.meta.reportId).toMatch(/^RPT-20261013-[0-9A-F]{4}$/);
    expect(report.totals).toMatchObject({ runs: 1, stageResults: 2, techniques: 2, actors: 1, highImpactUnprotected: 1 });
    expect(report.defenseScore).toEqual({ score: 61.5, rawScore: 58, riskAcceptedCount: 3 });

    const test = report.tests[0];
    expect(test).toMatchObject({ name: 'LockBit 3.0 Double Extortion Kill Chain', description: 'Emulates the LockBit 3.0 playbook.', score: 8.8 });
    expect(test.stages.map((s) => s.controlId)).toEqual(['T1567.002', 'T1486']);
    expect(test.stages[0].alerts).toEqual({ defender: 1, crowdstrike: 0 });

    expect(report.timeline.lanes).toEqual([{ testKey: BUNDLE, name: 'LockBit 3.0 Double Extortion Kill Chain', runs: 1 }]);
    expect(report.timeline.buckets[0].lanes[0]).toMatchObject({ testKey: BUNDLE, runs: 1 });

    const run = report.runs[0];
    expect(run).toMatchObject({ taskId: TASK, startedAt: '2026-10-12T12:41:06.000Z', hostname: 'WS-FIN-014', moreStages: 0 });
    expect(run.stages.map((s) => [s.controlId, s.outcome, s.highImpact])).toEqual([['T1567.002', 'unprotected', true], ['T1486', 'protected', false]]);
    expect(run.alerts[0]).toMatchObject({ vendor: 'defender', title: 'RcloneExfiltration', stageControlId: 't1567.002' });

    expect(report.findings[0]).toMatchObject({
      techniqueId: 'T1567.002', highImpact: true,
      guidance: { testKey: BUNDLE, excerpt: 'Exfiltration · M1021 Restrict Web-Based Content' },
    });
    expect(report.acceptedRisks).toBeNull();
    expect(report.meta.warnings).toEqual([]);
    expect(report.meta.unavailable).toEqual([]);
  });

  it('returns an empty report without the timeline query or any enrichment', async () => {
    const deps = makeDeps();
    deps.client.search.mockImplementation(async (req: { aggs: Record<string, unknown> }) =>
      (req.aggs.hosts ? scopeResponse({ outcomes: {}, runs: 0 }) : { aggregations: {} }));
    const report = await new ExecutionReportService(settings, deps).generate(params(), NOW);
    expect(report.totals.runs).toBe(0);
    expect(report.runs).toEqual([]);
    expect(deps.client.search).toHaveBeenCalledTimes(3);
    expect(deps.es.getDefenseScore).not.toHaveBeenCalled();
    expect(deps.client.msearch).not.toHaveBeenCalled();
  });

  it('turns optional failures into warnings', async () => {
    const deps = makeDeps();
    deps.es.getDefenseScore.mockRejectedValue(new Error('cluster busy'));
    deps.client.msearch.mockRejectedValue(new Error('index_not_found'));
    const report = await new ExecutionReportService(settings, deps).generate(params(), NOW);
    expect(report.defenseScore).toBeNull();
    expect(report.runs[0].alerts).toEqual([]);
    expect(report.meta.warnings).toHaveLength(2);
    expect(report.meta.warnings).toEqual(expect.arrayContaining([
      'Defense Score unavailable: cluster busy',
      'Microsoft Defender alerts unavailable: index_not_found',
    ]));
    expect(report.meta.unavailable).toEqual(['defenseScore', 'alerts']);
  });

  it('flags only the Defense Score when it alone fails', async () => {
    const deps = makeDeps();
    deps.es.getDefenseScore.mockRejectedValue(new Error('cluster busy'));
    const report = await new ExecutionReportService(settings, deps).generate(params(), NOW);
    expect(report.defenseScore).toBeNull();
    expect(report.meta.unavailable).toEqual(['defenseScore']);
    expect(report.runs[0].alerts).toHaveLength(1);
  });

  it('flags run start times that fail while they were attempted', async () => {
    const deps = makeDeps();
    deps.getRunStartTimes.mockRejectedValue(new Error('db locked'));
    const report = await new ExecutionReportService(settings, deps).generate(params(), NOW);
    expect(report.runs[0].startedAt).toBeNull();
    expect(report.meta.warnings).toEqual(['Run start times unavailable: db locked']);
    expect(report.meta.unavailable).toEqual(['startTimes']);
  });

  it('drops enrichments that outlive the time budget', async () => {
    const deps = makeDeps({ budgetMs: 30 });
    deps.es.getDefenseScore.mockImplementation(() => new Promise(() => {}));
    const report = await new ExecutionReportService(settings, deps).generate(params(), NOW);
    expect(report.defenseScore).toBeNull();
    expect(report.meta.warnings).toContain('Defense Score unavailable: time budget reached');
  });

  it('flags alerts unavailable when the overall budget ends while a vendor hangs', async () => {
    const deps = makeDeps({ budgetMs: 40, vendorBudgetMs: 5_000 });
    deps.client.msearch.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    const report = await new ExecutionReportService(settings, deps).generate(params(), NOW);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(report.runs[0].alerts).toEqual([]);
    expect(report.meta.warnings).toEqual([expect.stringMatching(/alerts unavailable: time budget reached$/)]);
    expect(report.meta.unavailable).toEqual(['alerts']);
  });

  it('echoes filters and flags outcome filtering', async () => {
    const report = await new ExecutionReportService(settings, makeDeps())
      .generate(params({ result: 'unprotected', errorCodes: '101', tags: 'lockbit' }), NOW);
    expect(report.meta.filters).toEqual({ result: 'unprotected', errorCodes: '101', tags: 'lockbit' });
    expect(report.meta.outcomeFiltered).toEqual(['result=unprotected', 'errorCodes=101']);
  });

  it('includes accepted risks only when permitted and marks covered findings', async () => {
    const deps = makeDeps({
      getAcceptances: vi.fn(async () => ({
        'Pre-encryption exfiltration::T1567.002': [{
          acceptance_id: 'r1', test_name: 'Pre-encryption exfiltration', control_id: 'T1567.002', scope: 'global',
          justification: 'Egress handled by proxy', accepted_by: 'u1', accepted_by_name: 'SOC lead',
          accepted_at: '2026-10-01T00:00:00Z', status: 'active',
        }],
      })),
    });
    const report = await new ExecutionReportService(settings, deps).generate(params({ includeAcceptedRisks: true }), NOW);
    expect(deps.getAcceptances).toHaveBeenCalledWith(expect.arrayContaining(['Pre-encryption exfiltration', 'Impact']), undefined);
    expect(report.acceptedRisks).toEqual([{
      testName: 'Pre-encryption exfiltration', controlId: 'T1567.002', hostname: null, scope: 'global',
      justification: 'Egress handled by proxy', acceptedBy: 'SOC lead', acceptedAt: '2026-10-01T00:00:00Z',
    }]);
    expect(report.findings[0].acceptedRisk).toBe(true);
  });

  it('scopes risk-acceptance reads to acceptanceOrg while ES and the Defense Score keep using org', async () => {
    const deps = makeDeps();
    await new ExecutionReportService(settings, deps)
      .generate(params({ org: 'agent-org', acceptanceOrg: 'org_clerk', includeAcceptedRisks: true }), NOW);
    expect(deps.getAcceptances).toHaveBeenCalledWith(expect.any(Array), 'org_clerk');
    const scope = { org: 'agent-org', from: '2026-09-13T23:40:00.000Z', to: '2026-10-13T23:40:00.000Z' };
    expect(deps.es.buildExtendedFilters).toHaveBeenCalledWith(scope);
    expect(deps.es.getDefenseScore).toHaveBeenCalledWith({ ...scope, scoringMode: 'any-stage' });
  });

  it('does not reuse the ES org as the acceptance org', async () => {
    const deps = makeDeps();
    await new ExecutionReportService(settings, deps)
      .generate(params({ org: 'agent-org', includeAcceptedRisks: true }), NOW);
    expect(deps.getAcceptances).toHaveBeenCalledWith(expect.any(Array), undefined);
  });

  it('keeps accepted risks empty and flags them unavailable when the lookup fails', async () => {
    const deps = makeDeps({ getAcceptances: vi.fn(async () => { throw new Error('risk index closed'); }) });
    const report = await new ExecutionReportService(settings, deps).generate(params({ includeAcceptedRisks: true }), NOW);
    expect(report.acceptedRisks).toEqual([]);
    expect(report.meta.unavailable).toEqual(['acceptedRisks']);
    expect(report.meta.warnings).toEqual(['Accepted risks unavailable: risk index closed']);
    expect(report.findings[0].acceptedRisk).toBe(false);
  });

  it('flags truncation and skips run start times above the strip threshold', async () => {
    const deps = makeDeps();
    deps.client.search.mockImplementation(routeSearch(scopeResponse({ runs: 1504 })));
    const report = await new ExecutionReportService(settings, deps).generate(params(), NOW);
    expect(report.meta.truncation.runs).toBe(true);
    expect(deps.getRunStartTimes).not.toHaveBeenCalled();
    expect(report.runs[0].startedAt).toBeNull();
    expect(report.meta.unavailable).toEqual([]); // skipped on purpose, not a failure
  });

  it('keeps ES metadata when the catalog has no entry for a test', async () => {
    // Custom upload, or a test removed from the library: ES has it, the catalog does not.
    const deps = makeDeps({ getTestMetadata: vi.fn(() => null) });
    const report = await new ExecutionReportService(settings, deps).generate(params(), NOW);
    expect(deps.getTestMetadata).toHaveBeenCalledWith(BUNDLE);
    expect(report.tests).toHaveLength(1);
    expect(report.tests[0]).toMatchObject({
      testKey: BUNDLE, name: 'LockBit 3.0 Double Extortion Kill Chain', category: 'intel-driven',
      description: null, severity: 'critical', threatActor: 'LockBit 3.0 (S1202)', score: null,
    });
    expect(report.tests[0].stages.map((s) => s.controlId)).toEqual(['T1567.002', 'T1486']);
    expect(report.meta.warnings).toEqual([]);
  });

  it('skips correlation when no EDR is configured', async () => {
    const deps = makeDeps({ vendors: { defender: false, crowdstrike: false } });
    const report = await new ExecutionReportService(settings, deps).generate(params(), NOW);
    expect(deps.client.msearch).not.toHaveBeenCalled();
    expect(report.runs[0].alerts).toEqual([]);
    expect(report.meta.unavailable).toEqual([]);
  });

  it('keeps one vendor\'s alerts when the other vendor rejects', async () => {
    const deps = makeDeps({ vendors: { defender: true, crowdstrike: true } });
    deps.client.msearch.mockImplementation(async (req: { searches: { index?: string }[] }) => {
      if (req.searches[0].index === 'achilles-defender') throw new Error('defender index closed');
      return msearchHits({ 'achilles-crowdstrike': 'FalconDetection' })(req);
    });
    const report = await new ExecutionReportService(settings, deps).generate(params(), NOW);
    expect(report.runs[0].alerts).toHaveLength(1);
    expect(report.runs[0].alerts[0]).toMatchObject({ vendor: 'crowdstrike', title: 'FalconDetection' });
    expect(report.meta.warnings).toEqual(['Microsoft Defender alerts unavailable: defender index closed']);
    expect(report.meta.unavailable).toEqual([]); // CrowdStrike still answered
  });

  it('flags alerts unavailable when every configured vendor fails', async () => {
    const deps = makeDeps({ vendors: { defender: true, crowdstrike: true } });
    deps.client.msearch.mockRejectedValue(new Error('cluster busy'));
    const report = await new ExecutionReportService(settings, deps).generate(params(), NOW);
    expect(report.runs[0].alerts).toEqual([]);
    expect(report.meta.warnings).toEqual([
      'Microsoft Defender alerts unavailable: cluster busy',
      'CrowdStrike Falcon alerts unavailable: cluster busy',
    ]);
    expect(report.meta.unavailable).toEqual(['alerts']);
  });

  it('cuts off a hung vendor at its own budget without losing the other vendor', async () => {
    const deps = makeDeps({ vendors: { defender: true, crowdstrike: true }, vendorBudgetMs: 50, budgetMs: 5_000 });
    deps.client.msearch.mockImplementation((req: { searches: { index?: string }[] }) =>
      (req.searches[0].index === 'achilles-defender'
        ? new Promise(() => {})
        : msearchHits({ 'achilles-crowdstrike': 'FalconDetection' })(req)));
    const started = Date.now();
    const report = await new ExecutionReportService(settings, deps).generate(params(), NOW);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(report.runs[0].alerts).toHaveLength(1);
    expect(report.runs[0].alerts[0]).toMatchObject({ vendor: 'crowdstrike', title: 'FalconDetection' });
    expect(report.meta.warnings).toEqual(['Microsoft Defender alerts unavailable: time budget reached']);
    expect(report.meta.unavailable).not.toContain('alerts');
  });

  it('warns when some correlation searches failed but keeps the alerts that were found', async () => {
    const deps = makeDeps();
    deps.client.msearch
      .mockImplementationOnce(async () => ({ responses: [{ error: { type: 'search_phase_execution_exception' } }] }))
      .mockImplementation(msearchHits({ 'achilles-defender': 'RcloneExfiltration' }));
    const report = await new ExecutionReportService(settings, deps).generate(params(), NOW);
    expect(report.meta.warnings).toEqual(['Microsoft Defender alerts partially unavailable: 1 searches failed']);
    expect(report.runs[0].alerts[0]).toMatchObject({ vendor: 'defender', title: 'RcloneExfiltration' });
  });

  it('warns when the vendor time budget cuts correlation short', async () => {
    const deps = makeDeps({ vendorBudgetMs: -1 });
    const report = await new ExecutionReportService(settings, deps).generate(params(), NOW);
    expect(deps.client.msearch).not.toHaveBeenCalled();
    expect(report.runs[0].alerts).toEqual([]);
    expect(report.meta.warnings).toEqual(['Microsoft Defender alerts incomplete: time budget reached']);
  });

  it('maps a required query failure to a 502', async () => {
    const deps = makeDeps();
    deps.client.search.mockRejectedValue(new Error('search_phase_execution_exception'));
    await expect(new ExecutionReportService(settings, deps).generate(params(), NOW)).rejects.toMatchObject({ statusCode: 502 });
  });

  it('maps a partial shard failure on a required query to a 502', async () => {
    const deps = makeDeps();
    deps.client.search.mockImplementation(routeSearch(Object.assign(scopeResponse(), {
      _shards: { total: 2, successful: 1, failed: 1, failures: [{ reason: { reason: 'boom' } }] },
    })));
    const err = await new ExecutionReportService(settings, deps).generate(params(), NOW).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 502 });
    expect(err.message).toContain('boom');
  });

  it('maps a timeline query failure to a 502', async () => {
    const deps = makeDeps();
    deps.client.search.mockImplementation(async (req: { aggs: Record<string, any> }) => {
      if (req.aggs.timeline) throw new Error('too_many_buckets');
      return routeSearch()(req);
    });
    await expect(new ExecutionReportService(settings, deps).generate(params(), NOW)).rejects.toMatchObject({ statusCode: 502 });
  });

  it('rejects an unknown time zone with a 400', async () => {
    await expect(new ExecutionReportService(settings, makeDeps()).generate(params({ tz: 'Nope/Nowhere' }), NOW))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});
