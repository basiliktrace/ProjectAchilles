// Vendor-neutral integration (CrowdStrike / Defender) API types.

/** ISO from/to window sent to the integration endpoints. */
export type TimeWindow = { from: string; to: string };

/** Alert feed source filter. Linked = Achilles-correlated; organic = everything else. */
export type AlertSource = 'all' | 'test' | 'organic';

/** Facet counts behind the alert feed's filter segments and summary strip. */
export interface AlertFacetCounts {
  /** All filters except source. */
  bySource: { all: number; test: number; organic: number };
  /** All filters except severity. */
  bySeverity: Record<string, number>;
  /** Alerts Achilles really resolved (enabled, error-free receipt). */
  autoResolved: number;
  /** Window only: linked AND status NOT IN ('closed','resolved'). */
  linkedOpen: number;
  /** CrowdStrike only. */
  byPrevention?: { prevented: number; detected_only: number; kill_failed: number };
  /** Defender only. */
  byProduct?: Record<string, number>;
}

export interface TechniqueCoverageItem {
  technique: string;
  name: string | null;
  executions: number;
  prevented: number;
  detectedOnly: number;
  missed: number;
  /** Vendor alerts tagged with this exact technique id in the window. */
  alerts: number;
}

export interface TechniqueCoverageResponse {
  overall: {
    executions: number;
    prevented: number;
    detectedOnly: number;
    missed: number;
    /** % of distinct executions, 1 dp, 0 when executions = 0. */
    detectionRate: number;
    /** % of distinct executions, 1 dp, 0 when executions = 0. */
    preventionRate: number;
    testedTechniques: number;
    detectedTechniques: number;
  };
  /** Detected first, then executions desc. */
  byTechnique: TechniqueCoverageItem[];
}

// ---------------------------------------------------------------------------
// Vendor-neutral shapes used by the shared integration components. The vendor
// clients' response types are structurally assignable to these.
// ---------------------------------------------------------------------------

export interface IntegrationAlertItem {
  alert_id: string;
  alert_title: string;
  severity: string;
  status: string;
  mitre_techniques: string[];
  created_at: string;
  hostname: string | null;
  prevention_action?: 'quarantined' | 'process_killed' | 'blocked' | 'kill_failed';
  portal_url?: string;
  achilles_correlated: boolean;
  achilles_test_uuid?: string;
  achilles_test_name?: string;
  /** Defender only (CrowdStrike items carry `product` instead). */
  service_source?: string;
}

export interface IntegrationAlertPage {
  data: IntegrationAlertItem[];
  total: number;
  page: number;
  pageSize: number;
  counts: AlertFacetCounts;
}

export interface IntegrationAlertSummary {
  total: number;
  bySeverity: Record<string, number>;
  counts: AlertFacetCounts;
}

export interface IntegrationTrendPoint {
  date: string;
  count: number;
  linked: number;
  interval: 'day' | 'week';
}

export interface IntegrationAlertQuery {
  page?: number;
  pageSize?: number;
  severity?: string;
  status?: string;
  search?: string;
  techniques?: string[];
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
  source?: AlertSource;
  severities?: string[];
  from?: string;
  to?: string;
}

/** The API surface the shared integration components depend on. */
export interface IntegrationApi {
  getAlerts(params?: IntegrationAlertQuery): Promise<IntegrationAlertPage>;
  getAlertSummary(window?: TimeWindow): Promise<IntegrationAlertSummary>;
  getAlertTrend(days?: number, window?: TimeWindow): Promise<IntegrationTrendPoint[]>;
  getTechniqueCoverage(window: TimeWindow): Promise<TechniqueCoverageResponse>;
}
