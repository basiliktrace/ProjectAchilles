import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  analyticsApi,
  type DefenseScore,
  type ErrorRateResponse,
  type ErrorRateTrendDataPoint,
  type TrendDataPoint,
} from '@/services/api/analytics';
import {
  defenderApi,
  type ControlItem,
  type SecureScoreSummary,
  type SecureScoreTrendPoint,
} from '@/services/api/defender';
import {
  crowdstrikeApi,
  type ZtaScoreSummary,
  type ZtaScoreTrendPoint,
} from '@/services/api/crowdstrike';
import { agentApi } from '@/services/api/agent';
import type { AgentMetrics, AgentTask, FleetHealthMetrics } from '@/types/agent';
import { browserApi, type SyncStatus } from '@/services/api/browser';
import type { TestMetadata } from '@/types/test';
import { useAnalyticsAuth } from '@/hooks/useAnalyticsAuth';
import { useDefenderConfig } from '@/hooks/useDefenderConfig';
import { useCrowdStrikeConfig } from '@/hooks/useCrowdStrikeConfig';
import { useOutdatedAgentCount } from '@/hooks/useOutdatedAgentCount';
import { useScoringMode } from '@/hooks/useScoringMode';
import { usePolling } from '@/hooks/usePolling';
import { formatUtcDay, utcDayKey } from '@/lib/utcDate';
import { pickCurrentScore, seriesDelta } from '@/lib/posture';
import { computeTestStats, type TestStats } from './computeTestStats';
import { deriveAttentionItems } from './deriveAttentionItems';
import type { AttentionItem } from './components/AttentionBanner';
import type { TrendPoint } from './components/TrendOverviewChart';
import type { RemediationControl } from './components/TopControlsCard';
import type { RecentExecution } from './components/RecentExecutionsCard';

const TOP_CONTROLS = 5;
const RECENT_TASKS = 6;
const AGENT_POLL_MS = 15_000;

/** Selectable dashboard time window; drives the analytics + Defender slices. */
export type DashboardRange = '7d' | '30d' | '90d';
export const DASHBOARD_RANGES: DashboardRange[] = ['7d', '30d', '90d'];
export const DEFAULT_DASHBOARD_RANGE: DashboardRange = '90d';

const RANGE_DAYS: Record<DashboardRange, number> = { '7d': 7, '30d': 30, '90d': 90 };

export function normalizeDashboardRange(value: string | null): DashboardRange {
  return (DASHBOARD_RANGES as string[]).includes(value ?? '')
    ? (value as DashboardRange)
    : DEFAULT_DASHBOARD_RANGE;
}

function settle<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null;
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Join secure/zta/error series onto the defense days by UTC day key. */
export function buildTrendPoints(
  defense: TrendDataPoint[] | null,
  error: ErrorRateTrendDataPoint[] | null,
  secure: SecureScoreTrendPoint[] | null,
  zta: ZtaScoreTrendPoint[] | null,
): TrendPoint[] {
  if (!defense?.length) return [];
  const errByDay = new Map((error ?? []).map((p) => [utcDayKey(p.timestamp), p.errorRate]));
  const secureByDay = new Map((secure ?? []).map((p) => [utcDayKey(p.date), p.percentage]));
  const ztaByDay = new Map((zta ?? []).map((p) => [utcDayKey(p.date), p.overallScore]));
  return defense.map((p) => {
    const day = utcDayKey(p.timestamp);
    return {
      date: formatUtcDay(p.timestamp),
      defense: p.score,
      secure: secureByDay.get(day) ?? null,
      zta: ztaByDay.get(day) ?? null,
      errorRate: errByDay.get(day) ?? null,
    };
  });
}

/** Describe the CURRENT value of each series; null parts are omitted. */
export function buildTrendDescription(parts: {
  defense: number | null;
  secure: number | null;
  zta: number | null;
  errorRate: number | null;
}): string {
  const out: string[] = [];
  if (parts.defense != null) out.push(`Defense ${parts.defense.toFixed(1)}%`);
  if (parts.secure != null) out.push(`Secure ${parts.secure.toFixed(1)}%`);
  if (parts.zta != null) out.push(`ZTA ${parts.zta.toFixed(1)}%`);
  if (parts.errorRate != null) out.push(`Error rate ${parts.errorRate.toFixed(1)}%`);
  return out.join(' · ');
}

export interface DashboardData {
  loading: boolean;
  // header
  syncStatus: SyncStatus | null;
  syncing: boolean;
  handleSync: () => Promise<void>;
  lastSyncedAgo?: string;
  // banner
  attentionItems: AttentionItem[];
  // KPIs + cards
  /** Defense score over the selected range. */
  defenseScore: DefenseScore | null;
  /** Current score: the trend's last point (matches the line), else the tile. */
  defenseCurrentScore: number | null;
  /** Test x endpoint pairs behind the current Defense Score. */
  defensePairCount: number | null;
  /** Last minus first scored point of the defense trend. */
  defenseDelta: number | null;
  defense7: DefenseScore | null;
  errorRate: ErrorRateResponse | null;
  secureScore: SecureScoreSummary | null;
  ztaScore: ZtaScoreSummary | null;
  testStats: TestStats | null;
  metrics: AgentMetrics | null;
  fleetHealth: FleetHealthMetrics | null;
  trend: TrendPoint[];
  trendDescription: string;
  controls: RemediationControl[];
  recentExecutions: RecentExecution[];
  analyticsConfigured: boolean;
  defenderConfigured: boolean;
  crowdstrikeConfigured: boolean;
}

export function useDashboardData(range: DashboardRange = DEFAULT_DASHBOARD_RANGE): DashboardData {
  const { configured: analyticsConfigured, loading: analyticsAuthLoading } = useAnalyticsAuth();
  const { configured: defenderConfigured, loading: defenderConfigLoading } = useDefenderConfig();
  const { configured: crowdstrikeConfigured, loading: crowdstrikeConfigLoading } = useCrowdStrikeConfig();
  const { scoringMode } = useScoringMode();
  const { outdatedCount } = useOutdatedAgentCount();

  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const [tests, setTests] = useState<TestMetadata[] | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [defenseScore, setDefenseScore] = useState<DefenseScore | null>(null);
  const [defense7, setDefense7] = useState<DefenseScore | null>(null);
  const [errorRate, setErrorRate] = useState<ErrorRateResponse | null>(null);
  const [defenseTrend, setDefenseTrend] = useState<TrendDataPoint[] | null>(null);
  const [errorTrend, setErrorTrend] = useState<ErrorRateTrendDataPoint[] | null>(null);
  const [secureScore, setSecureScore] = useState<SecureScoreSummary | null>(null);
  const [secureTrend, setSecureTrend] = useState<SecureScoreTrendPoint[] | null>(null);
  const [ztaScore, setZtaScore] = useState<ZtaScoreSummary | null>(null);
  const [ztaTrend, setZtaTrend] = useState<ZtaScoreTrendPoint[] | null>(null);
  const [rawControls, setRawControls] = useState<ControlItem[] | null>(null);
  const [metrics, setMetrics] = useState<AgentMetrics | null>(null);
  const [fleetHealth, setFleetHealth] = useState<FleetHealthMetrics | null>(null);
  const [recentTasks, setRecentTasks] = useState<AgentTask[] | null>(null);

  // Agent fleet slice — cheap SQLite queries, polled every 15s
  const loadAgentData = useCallback(async () => {
    const [m, fh, t] = await Promise.allSettled([
      agentApi.getMetrics(),
      agentApi.getFleetHealthMetrics(),
      agentApi.listTasks({ limit: RECENT_TASKS + 4 }),
    ]);
    setMetrics(settle(m));
    setFleetHealth(settle(fh));
    setRecentTasks(settle(t)?.tasks ?? null);
  }, []);

  // Test library slice
  const loadTestData = useCallback(async () => {
    const [allTests, sync] = await Promise.allSettled([
      browserApi.getAllTests(),
      browserApi.getSyncStatus(),
    ]);
    setTests(settle(allTests));
    setSyncStatus(settle(sync));
  }, []);

  // Analytics slice — Elasticsearch queries, reloaded on mount/sync/range change.
  const loadAnalyticsData = useCallback(async () => {
    if (!analyticsConfigured) return;
    const from = `now-${range}`;
    const [dRange, d7, er, dTrend, eTrend] = await Promise.allSettled([
      analyticsApi.getDefenseScore({ from, scoringMode, basis: 'latest' }),
      analyticsApi.getDefenseScore({ from: 'now-7d', scoringMode }),
      analyticsApi.getErrorRate({ from }),
      analyticsApi.getDefenseScoreTrend({ from, interval: 'day', scoringMode, basis: 'latest' }),
      analyticsApi.getErrorRateTrend({ from, interval: 'day' }),
    ]);
    setDefenseScore(settle(dRange));
    setDefense7(settle(d7));
    setErrorRate(settle(er));
    setDefenseTrend(settle(dTrend));
    setErrorTrend(settle(eTrend));
  }, [analyticsConfigured, scoringMode, range]);

  // Defender slice
  const loadDefenderData = useCallback(async () => {
    if (!defenderConfigured) return;
    const [score, trend, controls] = await Promise.allSettled([
      defenderApi.getSecureScore(),
      defenderApi.getSecureScoreTrend(RANGE_DAYS[range]),
      defenderApi.getControls({ deprecated: false }),
    ]);
    setSecureScore(settle(score));
    setSecureTrend(settle(trend));
    setRawControls(settle(controls));
  }, [defenderConfigured, range]);

  // CrowdStrike slice — ZTA may be unlicensed (403); settle() nulls it out
  // and the rest of the dashboard is unaffected.
  const loadCrowdStrikeData = useCallback(async () => {
    if (!crowdstrikeConfigured) return;
    const [score, trend] = await Promise.allSettled([
      crowdstrikeApi.getZtaScore(),
      crowdstrikeApi.getZtaScoreTrend(RANGE_DAYS[range]),
    ]);
    setZtaScore(settle(score));
    setZtaTrend(settle(trend));
  }, [crowdstrikeConfigured, range]);

  useEffect(() => {
    // Wait for config checks so we don't render "not configured" flashes
    if (analyticsAuthLoading || defenderConfigLoading || crowdstrikeConfigLoading) return;
    let cancelled = false;
    void Promise.all([loadAgentData(), loadTestData(), loadAnalyticsData(), loadDefenderData(), loadCrowdStrikeData()])
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [analyticsAuthLoading, defenderConfigLoading, crowdstrikeConfigLoading, loadAgentData, loadTestData, loadAnalyticsData, loadDefenderData, loadCrowdStrikeData]);

  usePolling(loadAgentData, AGENT_POLL_MS);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      const result = await browserApi.syncTests();
      setSyncStatus(result.syncStatus);
      await loadTestData();
    } finally {
      setSyncing(false);
    }
  }, [loadTestData]);

  const testStats = useMemo(() => (tests ? computeTestStats(tests) : null), [tests]);

  const trend = useMemo<TrendPoint[]>(
    () => buildTrendPoints(defenseTrend, errorTrend, secureTrend, ztaTrend),
    [defenseTrend, errorTrend, secureTrend, ztaTrend],
  );

  const current = useMemo(() => pickCurrentScore(defenseScore, defenseTrend), [defenseScore, defenseTrend]);
  const defenseDelta = useMemo(() => seriesDelta(defenseTrend ?? []), [defenseTrend]);

  const trendDescription = useMemo(() => {
    const lastError = [...(errorTrend ?? [])].reverse().find((p) => p.errorRate != null)?.errorRate;
    return buildTrendDescription({
      defense: current.score,
      secure: secureScore ? secureScore.percentage : null,
      zta: ztaScore ? ztaScore.overallScore : null,
      errorRate: lastError ?? errorRate?.errorRate ?? null,
    });
  }, [current, secureScore, ztaScore, errorTrend, errorRate]);

  const controls = useMemo<RemediationControl[]>(() => {
    if (!rawControls) return [];
    return [...rawControls]
      .sort((a, b) => b.max_score - a.max_score)
      .slice(0, TOP_CONTROLS)
      .map((c) => ({
        id: c.control_name,
        title: c.title,
        category: c.control_category,
        scoreImpact: `+${c.max_score.toFixed(2)}`,
        url: c.action_url || undefined,
      }));
  }, [rawControls]);

  const recentExecutions = useMemo<RecentExecution[]>(() => {
    if (!recentTasks) return [];
    return recentTasks
      .filter((t) => t.status === 'completed' || t.status === 'failed')
      .slice(0, RECENT_TASKS)
      .map((t) => ({
        id: t.id,
        testName: t.payload?.test_name || t.type,
        hostname: t.agent_hostname ?? undefined,
        status: t.status as 'completed' | 'failed',
        timeAgo: relativeTime(t.completed_at ?? t.created_at),
        to: `/tasks?search=${encodeURIComponent(t.payload?.test_name || t.id)}`,
      }));
  }, [recentTasks]);

  const attentionItems = useMemo(
    () =>
      loading
        ? []
        : deriveAttentionItems({
            offlineAgents: metrics?.offline ?? 0,
            staleAgents: fleetHealth?.stale_agent_count ?? 0,
            failedTasks24h: metrics?.task_activity_24h.failed ?? 0,
            outdatedAgents: outdatedCount,
            syncFailed: syncStatus?.status === 'error',
          }),
    [loading, metrics, fleetHealth, outdatedCount, syncStatus],
  );

  return {
    loading: loading || analyticsAuthLoading || defenderConfigLoading || crowdstrikeConfigLoading,
    syncStatus,
    syncing,
    handleSync,
    lastSyncedAgo: syncStatus?.lastSyncTime ? relativeTime(syncStatus.lastSyncTime) : undefined,
    attentionItems,
    defenseScore,
    defenseCurrentScore: current.score,
    defensePairCount: current.pairCount,
    defenseDelta,
    defense7,
    errorRate,
    secureScore,
    ztaScore,
    testStats,
    metrics,
    fleetHealth,
    trend,
    trendDescription,
    controls,
    recentExecutions,
    analyticsConfigured,
    defenderConfigured,
    crowdstrikeConfigured,
  };
}
