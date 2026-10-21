import { useState, useEffect } from 'react';
import { Gauge, Bell, Crosshair } from 'lucide-react';
import {
  crowdstrikeApi,
  type ZtaScoreSummary,
  type CrowdStrikeAlertSummary,
  type ZtaScoreTrendPoint,
  type CrowdStrikeAlertTrendPoint,
  type CrowdStrikeDetectionRateResponse,
} from '@/services/api/crowdstrike';
import { integrationsApi, type CrowdStrikeZtaStatus } from '@/services/api/integrations';
import CrowdStrikeTabHeader from './CrowdStrikeTabHeader';
import HeroStatTile, { type DeltaTone } from './HeroStatTile';
import CrowdStrikeAutoResolveStatTile from './CrowdStrikeAutoResolveStatTile';
import CrowdStrikeAlertsSummaryCard from './CrowdStrikeAlertsSummaryCard';
import CrowdStrikeTestVsAlertTimelineCard from './CrowdStrikeTestVsAlertTimelineCard';
import CrowdStrikeDetectionAnalysisCard from './CrowdStrikeDetectionAnalysisCard';
import CrowdStrikeTechniqueOverlapChart from './CrowdStrikeTechniqueOverlapChart';
import CrowdStrikeAlertDetailsDrawer from './CrowdStrikeAlertDetailsDrawer';
import CoveragePips from './CoveragePips';
import type { DateRangeValue } from '@/lib/timeRange';

const TREND_DAYS = 30;

function ztaScoreDelta(trend: ZtaScoreTrendPoint[]): number {
  if (trend.length < 2) return 0;
  return trend[trend.length - 1].overallScore - trend[0].overallScore;
}

function alertCountWindowDelta(trend: CrowdStrikeAlertTrendPoint[], windowDays: number): number {
  const recentStart = Math.max(0, trend.length - windowDays);
  const priorStart = Math.max(0, trend.length - windowDays * 2);
  const recent = trend.slice(recentStart).reduce((s, p) => s + p.count, 0);
  const prior = trend.slice(priorStart, recentStart).reduce((s, p) => s + p.count, 0);
  return recent - prior;
}

function inverseDeltaTone(delta: number | undefined): DeltaTone | undefined {
  if (delta === undefined) return undefined;
  if (delta > 0) return 'negative';
  if (delta < 0) return 'positive';
  return 'neutral';
}

interface CrowdStrikeTabProps {
  /** Page date range; drives the tab's window from the redesign onward. */
  dateRange: DateRangeValue;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function CrowdStrikeTab(_props: CrowdStrikeTabProps) {
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [ztaScore, setZtaScore] = useState<ZtaScoreSummary | null>(null);
  const [ztaScoreTrend, setZtaScoreTrend] = useState<ZtaScoreTrendPoint[]>([]);
  const [alertSummary, setAlertSummary] = useState<CrowdStrikeAlertSummary | null>(null);
  const [alertTrend, setAlertTrend] = useState<CrowdStrikeAlertTrendPoint[]>([]);
  const [detectionRate, setDetectionRate] = useState<CrowdStrikeDetectionRateResponse | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [ztaStatus, setZtaStatus] = useState<CrowdStrikeZtaStatus | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTechniques, setDrawerTechniques] = useState<string[] | undefined>(undefined);
  const [drawerTitle, setDrawerTitle] = useState<string | undefined>(undefined);

  function openDrawerForTechnique(t: string) {
    setDrawerTechniques([t]);
    setDrawerTitle(undefined);
    setDrawerOpen(true);
  }

  function openDrawerForAll() {
    setDrawerTechniques(undefined);
    setDrawerTitle(undefined);
    setDrawerOpen(true);
  }

  useEffect(() => {
    loadData();
    loadSyncStatus();
  }, []);

  async function loadData() {
    setLoading(true);
    const [scoreR, scoreTrendR, alertR, alertTrendR, detectR] = await Promise.allSettled([
      crowdstrikeApi.getZtaScore(),
      crowdstrikeApi.getZtaScoreTrend(TREND_DAYS),
      crowdstrikeApi.getAlertSummary(),
      crowdstrikeApi.getAlertTrend(TREND_DAYS),
      crowdstrikeApi.getDetectionRate(TREND_DAYS, 60),
    ]);

    if (scoreR.status === 'fulfilled') setZtaScore(scoreR.value);
    else console.error('Failed to load CrowdStrike ZTA score:', scoreR.reason);

    if (scoreTrendR.status === 'fulfilled') setZtaScoreTrend(scoreTrendR.value);
    else console.error('Failed to load ZTA score trend:', scoreTrendR.reason);

    if (alertR.status === 'fulfilled') setAlertSummary(alertR.value);
    else console.error('Failed to load CrowdStrike alert summary:', alertR.reason);

    if (alertTrendR.status === 'fulfilled') setAlertTrend(alertTrendR.value);
    else console.error('Failed to load alert trend:', alertTrendR.reason);

    if (detectR.status === 'fulfilled') setDetectionRate(detectR.value);
    else console.error('Failed to load detection rate:', detectR.reason);

    setLoading(false);
  }

  async function loadSyncStatus() {
    try {
      const status = await integrationsApi.getCrowdStrikeSyncStatus();
      const times = [status.lastAlertSync, status.lastZtaSync]
        .filter((t): t is string => !!t)
        .sort();
      setLastSync(times.at(-1) ?? null);
      setSyncError(status.lastError ? `${status.lastError.stage}: ${status.lastError.message || 'unknown error'}` : null);
      setZtaStatus(status.ztaStatus ?? null);
    } catch (err) {
      console.error('Failed to load CrowdStrike sync status:', err);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setSyncError(null);
    try {
      const result = await integrationsApi.triggerCrowdStrikeSync();
      const failed = (['alerts', 'zta'] as const).find((s) => (result[s]?.errors.length ?? 0) > 0);
      if (failed) setSyncError(`${failed}: ${result[failed].errors[0] || 'unknown error'}`);
      await loadData();
      await loadSyncStatus();
    } catch (err) {
      const apiError = (err as { response?: { data?: { error?: string } } }).response?.data?.error;
      setSyncError(apiError ?? (err instanceof Error ? err.message : 'Sync failed'));
    } finally {
      setSyncing(false);
    }
  }

  const scoreDelta = ztaScoreTrend.length >= 2 ? ztaScoreDelta(ztaScoreTrend) : undefined;
  const alertDeltaWeek = alertTrend.length >= 14 ? alertCountWindowDelta(alertTrend, 7) : undefined;

  const totalAlerts = alertSummary?.total ?? 0;
  const criticalAlerts = alertSummary?.bySeverity.critical ?? 0;
  const highAlerts = alertSummary?.bySeverity.high ?? 0;

  // ZTA is a separately-licensed Falcon Insight feature — a 403 during the
  // backend ZTA sync is recorded as zta_status:'not_licensed' and must not
  // break the rest of the tab. No score data at all gets the same graceful
  // empty state.
  const ztaUnavailable = !loading && (ztaStatus === 'not_licensed' || !ztaScore);
  const ztaEmptyState =
    ztaStatus === 'not_licensed'
      ? 'Posture score requires Falcon Insight licensing'
      : 'No posture score data yet — scores appear after the next sync';

  return (
    <div className="space-y-6">
      <CrowdStrikeTabHeader lastSync={lastSync} syncing={syncing} syncError={syncError} onSync={handleSync} />

      {/* Hero row: 4 tiles */}
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 sm:col-span-6 md:col-span-3">
          <HeroStatTile
            title="ZTA Score"
            icon={<Gauge className="w-4 h-4 text-primary" />}
            value={ztaScore?.overallScore.toFixed(1) ?? '—'}
            valueSuffix="%"
            subValue={
              ztaScore
                ? `${ztaScore.deviceCount.toLocaleString()} devices · OS ${ztaScore.osScore.toFixed(0)} · Sensor ${ztaScore.sensorConfigScore.toFixed(0)}`
                : undefined
            }
            delta={ztaUnavailable ? undefined : scoreDelta}
            deltaLabel={`pts vs ${TREND_DAYS}d ago`}
            sparklineData={ztaUnavailable ? undefined : ztaScoreTrend.map((p) => p.overallScore)}
            sparklineClass="text-emerald-500"
            loading={loading}
            emptyState={ztaUnavailable ? ztaEmptyState : undefined}
          />
        </div>
        <div className="col-span-12 sm:col-span-6 md:col-span-3">
          <HeroStatTile
            title="CrowdStrike Alerts"
            icon={<Bell className="w-4 h-4 text-primary" />}
            value={totalAlerts.toLocaleString()}
            subValue={
              alertSummary
                ? `${(criticalAlerts + highAlerts).toLocaleString()} critical/high severity`
                : undefined
            }
            delta={alertDeltaWeek}
            deltaTone={inverseDeltaTone(alertDeltaWeek)}
            deltaLabel="vs prev 7d"
            sparklineData={alertTrend.map((p) => p.count)}
            sparklineClass="text-red-500"
            loading={loading}
            onClick={openDrawerForAll}
          />
        </div>
        <div className="col-span-12 sm:col-span-6 md:col-span-3">
          <HeroStatTile
            title="Detection Rate"
            icon={<Crosshair className="w-4 h-4 text-primary" />}
            value={detectionRate?.overall.detectionRate.toFixed(1) ?? '—'}
            valueSuffix="%"
            subValue={
              detectionRate
                ? `${detectionRate.overall.correlatedExecutions.toLocaleString()} / ${detectionRate.overall.totalExecutions.toLocaleString()} executions detected`
                : undefined
            }
            chartSlot={
              detectionRate && detectionRate.byTechnique.length > 0 ? (
                <CoveragePips
                  items={detectionRate.byTechnique.map((t) => ({
                    technique: t.technique,
                    detected: t.detected,
                  }))}
                />
              ) : undefined
            }
            loading={loading}
          />
        </div>
        <div className="col-span-12 sm:col-span-6 md:col-span-3">
          <CrowdStrikeAutoResolveStatTile />
        </div>
      </div>

      {/* Correlation timeline */}
      <CrowdStrikeTestVsAlertTimelineCard />

      {/* Alert breakdown — CrowdStrike has no Secure Score controls pillar,
          so the summary card takes the full row instead of sharing it with a
          TopControlsCard equivalent. */}
      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 max-h-[600px]">
          <CrowdStrikeAlertsSummaryCard data={alertSummary} loading={loading} />
        </div>
      </div>

      {/* Detection analysis + Technique overlap side-by-side — both are
          per-technique horizontal-bar charts and share visual rhythm at
          half width. The cards are DIRECT grid children (no wrapper divs):
          DetectionAnalysisCard returns null when it has no data, and the
          only-child rule lets the overlap card take the full row instead
          of sitting beside an invisible half-width hole. */}
      <div className="grid grid-cols-12 gap-4 [&>:only-child]:col-span-12">
        <CrowdStrikeDetectionAnalysisCard
          className="col-span-12 max-h-[480px] lg:col-span-6"
          onSelectTechnique={openDrawerForTechnique}
        />
        <CrowdStrikeTechniqueOverlapChart
          className="col-span-12 max-h-[480px] lg:col-span-6"
          onSelectTechnique={openDrawerForTechnique}
        />
      </div>

      <CrowdStrikeAlertDetailsDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        techniques={drawerTechniques}
        title={drawerTitle}
      />
    </div>
  );
}
