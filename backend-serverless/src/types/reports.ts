// Execution report payload — GET /api/reports/executions.
// Mirrored in frontend/src/services/api/reports.ts; change both together.

export type StageOutcome =
  | 'protected'
  | 'prevented'
  | 'detected'
  | 'unprotected'
  | 'inconclusive'
  | 'skipped';

export type OutcomeCounts = Record<StageOutcome, number>;

export type TimeBucket = 'hour' | 'day' | 'week' | 'month';

export interface ReportWindow {
  /** '1d' | '7d' | '30d' | '90d' | 'all' | 'custom', derived from the bounds. */
  preset: string;
  /** e.g. 'Last 30 days', 'All time', 'Custom range'. */
  label: string;
  /** Absolute bounds every query used (resolved once at request start). */
  effectiveFrom: string;
  effectiveTo: string;
  /** Timeline axis (spec §5.5 rule 4). */
  axisFrom: string;
  axisTo: string;
  bucket: TimeBucket;
  firstExecution: string | null;
  lastExecution: string | null;
}

export interface ReportMeta {
  reportId: string;
  generatedAt: string;
  tz: string;
  org: { id: string | null; name: string | null };
  /** Applied filter-bar params, echoed (non-empty values only). */
  filters: Record<string, string>;
  /** Active outcome-selecting filters, e.g. ['result=unprotected']. */
  outcomeFiltered: string[];
  window: ReportWindow;
  truncation: { runs: boolean; tests: boolean; lanes: boolean };
  /** Section-level degradations, human readable. */
  warnings: string[];
}

export interface ReportTotals {
  runs: number;
  /** True above 10,000 runs, where the count comes from HyperLogLog. */
  runsApproximate: boolean;
  /** Stage results excluding skipped stages. */
  stageResults: number;
  endpoints: number;
  tests: number;
  techniques: number;
  tactics: number;
  actors: number;
  outcomes: OutcomeCounts;
  highImpactUnprotected: number;
}

export interface ReportDefenseScore {
  score: number | null;
  /** Score before accepted-risk exclusion; null when nothing is excluded. */
  rawScore: number | null;
  riskAcceptedCount: number;
}

export interface ReportTimelineLane {
  testKey: string;
  name: string;
  runs: number;
}

export interface ReportTimelineBucket {
  start: string;
  lanes: { testKey: string; runs: number; outcomes: OutcomeCounts }[];
}

export interface ReportTimeline {
  lanes: ReportTimelineLane[];
  buckets: ReportTimelineBucket[];
}

export interface ReportStage {
  controlId: string | null;
  name: string;
  order: number;
  techniques: string[];
  tactics: string[];
  outcomes: OutcomeCounts;
  /** Correlated alert counts from the runs list (the newest RUNS_CAP runs). */
  alerts: { defender: number; crowdstrike: number };
}

export interface ReportTest {
  testKey: string;
  name: string;
  isBundle: boolean;
  category: string | null;
  subcategory: string | null;
  severity: string | null;
  score: number | null;
  target: string[];
  complexity: string | null;
  threatActor: string | null;
  tags: string[];
  description: string | null;
  runs: number;
  endpoints: number;
  lastRun: string | null;
  outcomes: OutcomeCounts;
  stages: ReportStage[];
}

export interface ReportOtherTest {
  testKey: string;
  name: string;
  runs: number;
  outcomes: OutcomeCounts;
}

export interface ReportTechnique {
  id: string;
  name: string | null;
  tactic: string | null;
  outcomes: OutcomeCounts;
  testKeys: string[];
}

export interface ReportActor {
  name: string;
  testKeys: string[];
  runs: number;
  outcomes: OutcomeCounts;
}

export interface ReportHost {
  hostname: string;
  runs: number;
  outcomes: OutcomeCounts;
}

export interface ReportFinding {
  techniqueId: string;
  techniqueName: string | null;
  tactic: string | null;
  highImpact: boolean;
  outcomes: OutcomeCounts;
  testKeys: string[];
  testNames: string[];
  acceptedRisk: boolean;
  guidance: { testKey: string; testName: string; excerpt: string | null } | null;
}

export interface ReportRunStage {
  controlId: string | null;
  name: string;
  order: number;
  outcome: StageOutcome;
  exitCode: number | null;
  techniques: string[];
  tactics: string[];
  highImpact: boolean;
}

export interface ReportAlert {
  vendor: 'defender' | 'crowdstrike';
  title: string;
  severity: string;
  status: string;
  createdAt: string;
  /** Lowercased control token from the evidence binary; null = bundle-level. */
  stageControlId: string | null;
  preventionAction: string | null;
  portalUrl: string | null;
  autoResolvedAt: string | null;
}

export interface ReportRun {
  key: string;
  testKey: string;
  testName: string;
  hostname: string;
  completedAt: string;
  startedAt: string | null;
  taskId: string | null;
  stages: ReportRunStage[];
  /** Stage docs beyond MEMBERS_CAP that were not fetched. */
  moreStages: number;
  alerts: ReportAlert[];
}

export interface AcceptedRiskRow {
  testName: string;
  controlId: string | null;
  hostname: string | null;
  scope: 'host' | 'global';
  justification: string;
  acceptedBy: string;
  acceptedAt: string;
}

export interface ExecutionReport {
  meta: ReportMeta;
  totals: ReportTotals;
  defenseScore: ReportDefenseScore | null;
  timeline: ReportTimeline;
  tests: ReportTest[];
  otherTests: ReportOtherTest[];
  techniques: ReportTechnique[];
  actors: ReportActor[];
  hosts: ReportHost[];
  findings: ReportFinding[];
  runs: ReportRun[];
  /** null when the caller lacks analytics:risk:read. */
  acceptedRisks: AcceptedRiskRow[] | null;
}
