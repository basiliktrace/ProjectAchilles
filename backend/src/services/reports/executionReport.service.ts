// Execution report orchestration — GET /api/reports/executions (spec §5.2).
//
// Required phase: scope, tests and runs aggregations in parallel, then the
// timeline (it needs the top tests as lanes). A failure here is a 502, and so
// is a partial shard failure: a report built from some shards would misstate
// every count.
// Optional phase: Defense Score, EDR alerts, run start times and accepted
// risks run in parallel inside one time budget; each failure or timeout
// becomes a meta.warnings entry and the report still renders.
// Byte-identical in backend/ and backend-serverless/: fork differences sit
// behind taskTiming.ts, the catalog and the route.

import { randomBytes } from 'crypto';
import type { Client } from '@elastic/elasticsearch';
import { createEsClient } from '../analytics/client.js';
import { ElasticsearchService, ORG_NAMES } from '../analytics/elasticsearch.js';
import { RiskAcceptanceService, type RiskAcceptance } from '../risk-acceptance/risk-acceptance.service.js';
import { getTestDirectory, getTestMetadata } from '../agent/test-catalog.service.js';
import { AppError } from '../../middleware/error.middleware.js';
import { getRunStartTimes } from './taskTiming.js';
import { readDefenseGuidance } from './guidanceExcerpt.js';
import { correlateRuns, CROWDSTRIKE_ADAPTER, DEFENDER_ADAPTER, type CorrelationRun, type VendorAdapter } from './alertCorrelation.js';
import { computeTimeAxis, resolveReportWindow, validateTimeZone } from './reportWindow.js';
import {
  LANES_CAP, OTHER_LANE, RUN_STRIP_MAX_RUNS, TESTS_CAP,
  runsRequest, scopeRequest, testsRequest, timelineRequest,
} from './reportQueries.js';
import { parseRuns, parseScope, parseTests, parseTimeline } from './reportParsers.js';
import { attachGuidance, markAcceptedRisks, rankFindings } from './reportFindings.js';
import { emptyCounts } from './stageOutcome.js';
import type { AnalyticsSettings, DefenseScoreResponse, ExtendedAnalyticsQueryParams } from '../../types/analytics.js';
import type { TestMetadata } from '../../types/test.js';
import type {
  AcceptedRiskRow, ExecutionReport, ReportAlert, ReportDefenseScore, ReportEnrichment, ReportMeta, ReportRun, ReportTest,
  ReportTimelineLane,
} from '../../types/reports.js';

export const REPORT_BUDGET_MS = 45_000;
export const VENDOR_BUDGET_MS = 15_000;

const FILTER_KEYS = [
  'org', 'from', 'to', 'result', 'hostnames', 'tests', 'techniques', 'categories',
  'severities', 'threatActors', 'tags', 'errorNames', 'errorCodes', 'bundleNames',
] as const;
type FilterParams = Partial<Pick<ExtendedAnalyticsQueryParams, (typeof FILTER_KEYS)[number]>>;

export interface ExecutionReportParams extends FilterParams {
  tz: string;
  includeAcceptedRisks: boolean;
}

export interface ExecutionReportDeps {
  client: Client;
  es: Pick<ElasticsearchService, 'buildExtendedFilters' | 'getDefenseScore'>;
  vendors: { defender: boolean; crowdstrike: boolean };
  getTestMetadata: (uuid: string) => TestMetadata | null;
  readGuidance: (testKey: string) => string | null;
  getRunStartTimes: (taskIds: string[]) => Promise<Map<string, string>>;
  getAcceptances: (testNames: string[], org?: string) => Promise<Record<string, RiskAcceptance[]>>;
  budgetMs: number;
  vendorBudgetMs: number;
}

/** Fixed order for meta.unavailable, whatever order the steps finished in. */
const ENRICHMENT_ORDER: readonly ReportEnrichment[] = ['defenseScore', 'alerts', 'startTimes', 'acceptedRisks'];

/** What `correlate()` hands back: warnings are returned, not pushed, so a step abandoned at the deadline cannot add any late. */
interface Correlation {
  alerts: Map<string, ReportAlert[]>;
  warnings: string[];
  /** Every configured vendor rejected or timed out. */
  allFailed: boolean;
}

const VENDOR_LABEL: Record<ReportAlert['vendor'], string> = {
  defender: 'Microsoft Defender',
  crowdstrike: 'CrowdStrike Falcon',
};

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function withDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('time budget reached')), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function pickFilters(params: ExecutionReportParams): FilterParams {
  const out: Record<string, unknown> = {};
  for (const key of FILTER_KEYS) {
    const value = params[key];
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out as FilterParams;
}

function echoFilters(params: ExecutionReportParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FILTER_KEYS) {
    if (key === 'from' || key === 'to') continue;
    const value = params[key];
    if (value === undefined || value === '' || (key === 'result' && value === 'all')) continue;
    out[key] = String(value);
  }
  return out;
}

function outcomeFilters(params: ExecutionReportParams): string[] {
  const out: string[] = [];
  if (params.result && params.result !== 'all') out.push(`result=${params.result}`);
  if (params.errorNames) out.push(`errorNames=${params.errorNames}`);
  if (params.errorCodes) out.push(`errorCodes=${params.errorCodes}`);
  return out;
}

function makeReportId(now: Date): string {
  return `RPT-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(2).toString('hex').toUpperCase()}`;
}

function toDefenseScore(d: DefenseScoreResponse | null): ReportDefenseScore | null {
  if (!d) return null;
  if (!d.totalExecutions) return { score: null, rawScore: null, riskAcceptedCount: 0 };
  const accepted = d.riskAcceptedCount ?? 0;
  return { score: d.score, rawScore: accepted > 0 ? d.rawScore ?? null : null, riskAcceptedCount: accepted };
}

function toAcceptedRiskRows(acceptances: Record<string, RiskAcceptance[]> | null): AcceptedRiskRow[] {
  const unique = new Map<string, RiskAcceptance>();
  for (const list of Object.values(acceptances ?? {})) for (const a of list) unique.set(a.acceptance_id, a);
  return [...unique.values()]
    .map((a) => ({
      testName: a.test_name,
      controlId: a.control_id ?? null,
      hostname: a.hostname ?? null,
      scope: a.scope ?? (a.hostname ? 'host' : 'global'),
      justification: a.justification,
      acceptedBy: a.accepted_by_name || a.accepted_by,
      acceptedAt: a.accepted_at,
    }))
    .sort((x, y) => x.testName.localeCompare(y.testName) || (x.hostname ?? '').localeCompare(y.hostname ?? ''));
}

function buildLanes(tests: ReportTest[]): ReportTimelineLane[] {
  const lanes = tests.slice(0, LANES_CAP).map((t) => ({ testKey: t.testKey, name: t.name, runs: t.runs }));
  const rest = tests.slice(LANES_CAP);
  if (rest.length > 0) {
    lanes.push({ testKey: OTHER_LANE, name: `Other tests (${rest.length})`, runs: rest.reduce((sum, t) => sum + t.runs, 0) });
  }
  return lanes;
}

/** Credit each correlated alert to the stage its evidence binary names. */
function countStageAlerts(tests: ReportTest[], runs: ReportRun[]): void {
  const byKey = new Map(tests.map((t) => [t.testKey, t]));
  for (const run of runs) {
    const test = byKey.get(run.testKey);
    if (!test) continue;
    for (const alert of run.alerts) {
      const token = alert.stageControlId;
      const stage = test.stages.length === 1
        ? test.stages[0]
        : token === null
          ? undefined
          : test.stages.find((s) => {
              const id = s.controlId?.toLowerCase();
              return id !== undefined && (token === id || token.startsWith(`${id}-`));
            });
      if (stage) stage.alerts[alert.vendor]++;
    }
  }
}

function emptyReport(meta: ReportMeta): ExecutionReport {
  return {
    meta,
    totals: {
      runs: 0, runsApproximate: false, stageResults: 0, endpoints: 0, tests: 0, techniques: 0,
      tactics: 0, actors: 0, outcomes: emptyCounts(), highImpactUnprotected: 0,
    },
    defenseScore: null,
    timeline: { lanes: [], buckets: [] },
    tests: [],
    otherTests: [],
    techniques: [],
    actors: [],
    hosts: [],
    findings: [],
    runs: [],
    acceptedRisks: null,
  };
}

/** `testKey` is the bare catalog uuid, never a `<bundle>::<control>` composite. */
function defaultReadGuidance(testKey: string): string | null {
  const dir = getTestDirectory(testKey);
  return dir ? readDefenseGuidance(dir, testKey) : null;
}

export class ExecutionReportService {
  private readonly deps: ExecutionReportDeps;
  private ownClient: Client | null = null;

  constructor(
    private readonly settings: AnalyticsSettings,
    deps: Partial<ExecutionReportDeps> & Pick<ExecutionReportDeps, 'vendors'>,
  ) {
    const realClient = (): Client => (this.ownClient ??= createEsClient(settings));
    this.deps = {
      client: deps.client ?? realClient(),
      es: deps.es ?? new ElasticsearchService(settings),
      vendors: deps.vendors,
      getTestMetadata: deps.getTestMetadata ?? getTestMetadata,
      readGuidance: deps.readGuidance ?? defaultReadGuidance,
      getRunStartTimes: deps.getRunStartTimes ?? getRunStartTimes,
      getAcceptances: deps.getAcceptances
        ?? ((names, org) => new RiskAcceptanceService(realClient()).getAcceptancesForControls(names, org)),
      budgetMs: deps.budgetMs ?? REPORT_BUDGET_MS,
      vendorBudgetMs: deps.vendorBudgetMs ?? VENDOR_BUDGET_MS,
    };
  }

  async generate(params: ExecutionReportParams, now: Date = new Date()): Promise<ExecutionReport> {
    const deadline = Date.now() + this.deps.budgetMs;
    const warnings: string[] = [];
    const tz = validateTimeZone(params.tz || 'UTC');
    const window = resolveReportWindow({ from: params.from, to: params.to }, now);
    const filterParams: FilterParams = { ...pickFilters(params), from: window.effectiveFrom, to: window.effectiveTo };
    const filters = this.deps.es.buildExtendedFilters(filterParams);

    // ── Required phase ──
    let scopeRes: unknown;
    let testsRes: unknown;
    let runsRes: unknown;
    try {
      [scopeRes, testsRes, runsRes] = await Promise.all([
        this.search(scopeRequest(filters)),
        this.search(testsRequest(filters)),
        this.search(runsRequest(filters)),
      ]);
    } catch (err) {
      throw new AppError(`Report query failed: ${errorMessage(err)}`, 502);
    }

    const scope = parseScope(scopeRes);
    const axis = computeTimeAxis(window, scope.firstExecution);
    const meta: ReportMeta = {
      reportId: makeReportId(now),
      generatedAt: now.toISOString(),
      tz,
      org: { id: params.org ?? null, name: params.org ? ORG_NAMES[params.org] ?? null : null },
      filters: echoFilters(params),
      outcomeFiltered: outcomeFilters(params),
      window: { ...window, ...axis, firstExecution: scope.firstExecution, lastExecution: scope.lastExecution },
      truncation: { runs: false, tests: false, lanes: false },
      warnings,
      unavailable: [],
    };
    if (scope.stageResults + scope.outcomes.skipped === 0) return emptyReport(meta);

    const allTests = parseTests(testsRes).map((t) => this.withCatalog(t));
    const laneKeys = allTests.slice(0, LANES_CAP).map((t) => t.testKey);
    let timelineRes: unknown = {};
    if (laneKeys.length > 0) {
      try {
        timelineRes = await this.search(timelineRequest(filters, laneKeys, axis.bucket, tz));
      } catch (err) {
        throw new AppError(`Report query failed: ${errorMessage(err)}`, 502);
      }
    }
    const runs = parseRuns(runsRes);

    // ── Optional phase ──
    const unavailable = new Set<ReportEnrichment>();
    const optional = async <T>(label: string, section: ReportEnrichment, work: () => Promise<T>): Promise<T | null> => {
      try {
        return await withDeadline(work(), deadline);
      } catch (err) {
        warnings.push(`${label} unavailable: ${errorMessage(err)}`);
        unavailable.add(section);
        return null;
      }
    };
    const taskIds = runs.flatMap((r) => (r.taskId ? [r.taskId] : []));
    const stageNames = [...new Set(allTests.flatMap((t) => t.stages.map((s) => s.name)))];

    const [defense, correlation, startTimes, acceptances] = await Promise.all([
      optional('Defense Score', 'defenseScore', () => this.deps.es.getDefenseScore({ ...filterParams, scoringMode: 'any-stage' })),
      optional('EDR alerts', 'alerts', () => this.correlate(runs, deadline)),
      scope.runs <= RUN_STRIP_MAX_RUNS && taskIds.length > 0
        ? optional('Run start times', 'startTimes', () => this.deps.getRunStartTimes(taskIds))
        : Promise.resolve(null),
      params.includeAcceptedRisks
        ? optional('Accepted risks', 'acceptedRisks', () => this.deps.getAcceptances(stageNames, params.org))
        : Promise.resolve(null),
    ]);

    // A vendor failing while another answers is conveyed by its warning alone; only a wholly failed step is "unavailable".
    if (correlation) {
      warnings.push(...correlation.warnings);
      if (correlation.allFailed) unavailable.add('alerts');
    }
    meta.unavailable = ENRICHMENT_ORDER.filter((section) => unavailable.has(section));

    for (const run of runs) {
      run.alerts = correlation?.alerts.get(run.key) ?? [];
      run.startedAt = run.taskId ? startTimes?.get(run.taskId) ?? null : null;
    }
    countStageAlerts(allTests, runs);

    const findings = attachGuidance(
      markAcceptedRisks(rankFindings(scope.techniques, allTests), allTests, acceptances ?? {}),
      allTests,
      this.deps.readGuidance,
    );

    meta.truncation = { runs: scope.runs > runs.length, tests: allTests.length > TESTS_CAP, lanes: allTests.length > LANES_CAP };

    return {
      meta,
      totals: {
        runs: scope.runs,
        runsApproximate: scope.runsApproximate,
        stageResults: scope.stageResults,
        endpoints: scope.endpoints,
        tests: scope.tests,
        techniques: scope.techniques.length,
        tactics: scope.tactics,
        actors: scope.actors.length,
        outcomes: scope.outcomes,
        highImpactUnprotected: scope.highImpactUnprotected,
      },
      defenseScore: toDefenseScore(defense),
      timeline: { lanes: buildLanes(allTests), buckets: parseTimeline(timelineRes, laneKeys) },
      tests: allTests.slice(0, TESTS_CAP),
      otherTests: allTests.slice(TESTS_CAP).map((t) => ({ testKey: t.testKey, name: t.name, runs: t.runs, outcomes: t.outcomes })),
      techniques: scope.techniques,
      actors: scope.actors,
      hosts: scope.hosts,
      findings,
      runs,
      acceptedRisks: params.includeAcceptedRisks ? toAcceptedRiskRows(acceptances) : null,
    };
  }

  /** A required query (Q1–Q4). A response from a subset of shards is a failure, not a smaller report. */
  private async search(body: Record<string, unknown>): Promise<unknown> {
    const response = await this.deps.client.search({ index: this.settings.indexPattern, ...body } as never);
    const shards = (response as { _shards?: { failed?: number; failures?: { reason?: { reason?: string } }[] } })._shards;
    if (shards?.failed && shards.failed > 0) {
      const reason = shards.failures?.[0]?.reason?.reason;
      throw new Error(reason ? `shard failure: ${reason}` : 'shard failure');
    }
    return response;
  }

  /** Catalog fields win over ES fields; the display name stays ES's (what the console shows). */
  private withCatalog(test: ReportTest): ReportTest {
    const md = this.deps.getTestMetadata(test.testKey);
    if (!md) return test;
    return {
      ...test,
      description: md.description ?? null,
      threatActor: md.threatActor ?? test.threatActor,
      severity: md.severity ?? test.severity,
      score: md.score ?? test.score,
      complexity: md.complexity ?? test.complexity,
      category: md.category ?? test.category,
      subcategory: md.subcategory ?? test.subcategory,
      tags: md.tags?.length ? md.tags : test.tags,
      target: md.target?.length ? md.target : test.target,
    };
  }

  /**
   * Each vendor fails alone, inside its own budget: one vendor's rejection or hang drops only that
   * vendor's alerts. `correlateRuns` only checks its deadline between batches, so the race is what
   * bounds an msearch that is already in flight.
   */
  private async correlate(runs: ReportRun[], deadline: number): Promise<Correlation> {
    const adapters: VendorAdapter[] = [
      ...(this.deps.vendors.defender ? [DEFENDER_ADAPTER] : []),
      ...(this.deps.vendors.crowdstrike ? [CROWDSTRIKE_ADAPTER] : []),
    ];
    const merged = new Map<string, ReportAlert[]>();
    const warnings: string[] = [];
    if (adapters.length === 0 || runs.length === 0) return { alerts: merged, warnings, allFailed: false };

    const correlationRuns: CorrelationRun[] = runs.map((r) => ({
      key: r.key,
      testKey: r.testKey,
      hostname: r.hostname,
      completedAt: r.completedAt,
      bundleName: r.key.startsWith('bundle::') ? r.testName : undefined,
      techniques: [...new Set(r.stages.flatMap((s) => s.techniques))],
    }));
    const vendorDeadline = Math.min(deadline, Date.now() + this.deps.vendorBudgetMs);
    const settled = await Promise.allSettled(
      adapters.map((a) => withDeadline(
        correlateRuns(this.deps.client, a, correlationRuns, { deadline: vendorDeadline }),
        vendorDeadline,
      )),
    );

    let failedVendors = 0;
    settled.forEach((outcome, i) => {
      const label = VENDOR_LABEL[adapters[i].vendor];
      if (outcome.status === 'rejected') {
        failedVendors++;
        warnings.push(`${label} alerts unavailable: ${errorMessage(outcome.reason)}`);
        return;
      }
      const res = outcome.value;
      if (!res.complete) warnings.push(`${label} alerts incomplete: time budget reached`);
      if (res.failed > 0) warnings.push(`${label} alerts partially unavailable: ${res.failed} searches failed`);
      for (const [key, list] of res.alerts) merged.set(key, [...(merged.get(key) ?? []), ...list]);
    });
    for (const list of merged.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { alerts: merged, warnings, allFailed: failedVendors === adapters.length };
  }
}
