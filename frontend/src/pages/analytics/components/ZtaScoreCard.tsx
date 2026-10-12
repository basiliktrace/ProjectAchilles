import { memo } from 'react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { ZtaScoreSummary } from '@/services/api/crowdstrike';

interface ZtaScoreCardProps {
  data: ZtaScoreSummary | null;
  loading?: boolean;
}

// Score-based semantic color + matching bar fill: accent (≥80), warning (≥60), danger (<60)
function scoreClasses(score: number): { text: string; bar: string } {
  if (score >= 80) return { text: 'text-accent', bar: 'bg-accent' };
  if (score >= 60) return { text: 'text-warning', bar: 'bg-warning' };
  return { text: 'text-danger', bar: 'bg-danger' };
}

/**
 * Compact ZTA score card — CrowdStrike Zero Trust Assessment counterpart of
 * SecureScoreCard. ZTA scores are 0–100 per host, averaged org-wide daily.
 */
function ZtaScoreCard({ data, loading }: ZtaScoreCardProps) {
  if (loading || !data) {
    return (
      <Card className="flex flex-col gap-3 p-5" aria-busy="true">
        <Skeleton className="h-3 w-36" />
        <div className="flex items-center gap-4">
          <Skeleton className="h-9 w-24" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-1.5 w-full rounded-full" />
            <Skeleton className="h-3 w-28" />
          </div>
        </div>
      </Card>
    );
  }

  const { text, bar } = scoreClasses(data.overallScore);
  const fillPct = Math.max(0, Math.min(100, data.overallScore));

  return (
    <Card className="flex flex-col gap-3 p-5">
      <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-faint">
        ZTA Score · CrowdStrike
      </span>
      <div className="flex items-center gap-4">
        <span className={`font-mono text-[32px] font-semibold leading-none ${text}`}>
          {data.overallScore.toFixed(1)}%
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="h-1.5 rounded-full bg-raised">
            <div className={`h-full rounded-full ${bar}`} style={{ width: `${fillPct}%` }} />
          </div>
          <span className="font-mono text-[11px] text-muted">
            {data.deviceCount.toLocaleString()} devices assessed
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between border-t border-raised pt-2">
        <span className="text-xs text-muted">OS posture</span>
        <span className="font-mono text-xs">{data.osScore.toFixed(1)}</span>
      </div>
      <div className="flex items-center justify-between border-t border-raised pt-2">
        <span className="text-xs text-muted">Sensor config</span>
        <span className="font-mono text-xs">{data.sensorConfigScore.toFixed(1)}</span>
      </div>
    </Card>
  );
}

export default memo(ZtaScoreCard);
