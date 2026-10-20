import { memo } from 'react';
import { TrendingUp } from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid
} from 'recharts';
import type { TrendDataPoint, ErrorRateTrendDataPoint } from '../../../services/api/analytics';
import type { SecureScoreTrendPoint } from '@/services/api/defender';
import type { ZtaScoreTrendPoint } from '@/services/api/crowdstrike';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig
} from '@/components/ui/chart';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUtcDay, utcDayKey } from '@/lib/utcDate';

/** Last non-null value of a series, or null when there is none. */
function lastNonNull<T>(items: T[], pick: (item: T) => number | null | undefined): number | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const v = pick(items[i]);
    if (v != null && !Number.isNaN(v)) return v;
  }
  return null;
}

interface TrendChartProps {
  data: TrendDataPoint[];
  errorRateData?: ErrorRateTrendDataPoint[];
  secureScoreTrendData?: SecureScoreTrendPoint[];
  ztaScoreTrendData?: ZtaScoreTrendPoint[];
  loading?: boolean;
  title?: string;
}

const chartConfig = {
  score: {
    label: 'Defense Score',
    color: 'var(--chart-protected)',
  },
  realScore: {
    label: 'Actual Score',
    color: 'var(--chart-real-score)',
  },
  errorRate: {
    label: 'Error Rate',
    color: 'var(--chart-bypassed)',
  },
  secureScore: {
    label: 'Secure Score',
    color: 'var(--chart-series-alert)',
  },
  ztaScore: {
    label: 'ZTA Score',
    color: 'var(--chart-warn)',
  },
} satisfies ChartConfig;

function TrendChart({ data, errorRateData, secureScoreTrendData, ztaScoreTrendData, loading, title = 'Trend Overview' }: TrendChartProps) {
  const hasErrorRate = errorRateData && errorRateData.length > 0;
  const hasSecureScore = secureScoreTrendData && secureScoreTrendData.length > 0;
  const hasZtaScore = ztaScoreTrendData && ztaScoreTrendData.length > 0;
  // The Actual (pre-risk-acceptance) line only adds information where it differs from the score.
  const hasRealScore = data.some(d => d.realScore != null && d.realScore !== d.score);
  const hasExtraData = hasErrorRate || hasSecureScore || hasZtaScore || hasRealScore;

  if (loading) {
    return (
      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
        </CardHeader>
        <CardContent className="h-[200px] flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-full w-full" />
        </CardContent>
      </Card>
    );
  }

  // Return early if no data to prevent rendering issues
  if (!data || data.length === 0) {
    return (
      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
        </CardHeader>
        <CardContent className="h-[200px] flex items-center justify-center">
          <p className="text-sm text-muted-foreground">No trend data available</p>
        </CardContent>
      </Card>
    );
  }

  // Build error rate lookup by date key
  const errorRateByDate = new Map<string, ErrorRateTrendDataPoint>();
  if (hasErrorRate) {
    for (const point of errorRateData) {
      errorRateByDate.set(utcDayKey(point.timestamp), point);
    }
  }

  // Build secure score lookup by date key (normalize ISO dates to YYYY-MM-DD to match defense score keys)
  const secureScoreByDate = new Map<string, SecureScoreTrendPoint>();
  if (hasSecureScore) {
    for (const point of secureScoreTrendData) {
      secureScoreByDate.set(utcDayKey(point.date), point);
    }
  }

  // Build ZTA score lookup by date key (same normalization as secure score)
  const ztaScoreByDate = new Map<string, ZtaScoreTrendPoint>();
  if (hasZtaScore) {
    for (const point of ztaScoreTrendData) {
      ztaScoreByDate.set(utcDayKey(point.date), point);
    }
  }

  // Merge datasets: defense score is the primary axis, error rate + secure score joined by date
  const chartData = data.map(point => {
    const dateKey = utcDayKey(point.timestamp);
    const errPoint = errorRateByDate.get(dateKey);
    const ssPoint = secureScoreByDate.get(dateKey);
    const ztaPoint = ztaScoreByDate.get(dateKey);
    return {
      ...point,
      realScore: point.realScore ?? null,
      realTotal: point.realTotal ?? 0,
      realProtected: point.realProtected ?? 0,
      errorRate: errPoint?.errorRate ?? null,
      errorCount: errPoint?.errorCount ?? 0,
      errorTotal: errPoint?.total ?? 0,
      secureScore: ssPoint?.percentage ?? null,
      secureScorePoints: ssPoint?.score ?? 0,
      secureScoreMax: ssPoint?.maxScore ?? 0,
      ztaScore: ztaPoint?.overallScore ?? null,
      ztaDeviceCount: ztaPoint?.deviceCount ?? 0,
      date: formatUtcDay(point.timestamp, 'short'),
      fullDate: formatUtcDay(point.timestamp, 'long'),
    };
  });

  // Header shows the CURRENT (last) value of each series; null parts are omitted.
  // Defense (and its Actual variant) use the last point itself, like the ring
  // (pickCurrentScore): when nothing is fresh at the end of the range the
  // header shows no Defense value rather than an older one.
  const fmt = (v: number | null | undefined) => (v == null ? null : v.toFixed(1));
  const lastPoint = chartData.at(-1);
  const lastDefense = fmt(lastPoint?.score);
  const lastRealScore = hasRealScore ? fmt(lastPoint?.realScore) : null;
  const lastErrorRate = hasErrorRate ? fmt(lastNonNull(errorRateData, d => d.errorRate)) : null;
  const lastSecureScore = hasSecureScore ? fmt(lastNonNull(secureScoreTrendData, d => d.percentage)) : null;
  const lastZtaScore = hasZtaScore ? fmt(lastNonNull(ztaScoreTrendData, d => d.overallScore)) : null;

  // Show only 5-7 ticks max to prevent overflow
  const tickCount = Math.min(7, chartData.length);
  const tickInterval = chartData.length > tickCount ? Math.floor(chartData.length / tickCount) : 0;

  return (
    <Card className="h-full overflow-hidden flex flex-col">
      <CardHeader className="flex-shrink-0 pb-0">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <CardDescription className="flex items-center gap-2 text-sm flex-wrap">
          {lastDefense !== null && <span>Defense: {lastDefense}%</span>}
          {lastRealScore !== null && (
            <>
              <span className="text-muted-foreground">|</span>
              <span>Actual: {lastRealScore}%</span>
            </>
          )}
          {lastSecureScore !== null && (
            <>
              <span className="text-muted-foreground">|</span>
              <span>Secure Score: {lastSecureScore}%</span>
            </>
          )}
          {lastZtaScore !== null && (
            <>
              <span className="text-muted-foreground">|</span>
              <span>ZTA Score: {lastZtaScore}%</span>
            </>
          )}
          {lastErrorRate !== null && (
            <>
              <span className="text-muted-foreground">|</span>
              <span>Error rate: {lastErrorRate}%</span>
            </>
          )}
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 p-4 flex flex-col">
        <div className="flex-1 w-full min-h-0 overflow-hidden">
          <ChartContainer
            config={chartConfig}
            className="h-full w-full"
          >
          <AreaChart
            data={chartData}
            margin={{ top: 10, right: 12, left: 0, bottom: 0 }}
          >
            <defs>
              <linearGradient id="fillScore" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="5%"
                  stopColor="var(--color-score)"
                  stopOpacity={0.8}
                />
                <stop
                  offset="95%"
                  stopColor="var(--color-score)"
                  stopOpacity={0.1}
                />
              </linearGradient>
              <linearGradient id="fillErrorRate" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="5%"
                  stopColor="var(--color-errorRate)"
                  stopOpacity={0.8}
                />
                <stop
                  offset="95%"
                  stopColor="var(--color-errorRate)"
                  stopOpacity={0.1}
                />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              interval={tickInterval}
              tick={{ fontSize: 11 }}
            />
            <YAxis
              domain={[0, 100]}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(value) => `${value}%`}
              width={48}
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) => {
                    if (payload && payload[0]) {
                      return payload[0].payload.fullDate;
                    }
                    return '';
                  }}
                  formatter={(value, name, item) => {
                    const payload = item.payload;
                    const config = chartConfig[name as keyof typeof chartConfig];
                    if (!config) return null;
                    return (
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          <div
                            className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                            style={{ backgroundColor: config.color }}
                          />
                          <span className="text-muted-foreground">{config.label}:</span>
                          <span className="text-foreground font-medium">
                            {Number(value).toFixed(1)}%
                          </span>
                        </div>
                        {name === 'score' && payload.total > 0 && (
                          <span className="text-xs text-muted-foreground ml-[18px]">
                            {payload.protected}/{payload.total} pairs protected
                          </span>
                        )}
                        {name === 'errorRate' && payload.errorTotal > 0 && (
                          <span className="text-xs text-muted-foreground ml-[18px]">
                            {payload.errorCount}/{payload.errorTotal} errors
                          </span>
                        )}
                        {name === 'realScore' && payload.realTotal > 0 && (
                          <span className="text-xs text-muted-foreground ml-[18px]">
                            {payload.realProtected}/{payload.realTotal} pairs protected
                          </span>
                        )}
                        {name === 'secureScore' && payload.secureScoreMax > 0 && (
                          <span className="text-xs text-muted-foreground ml-[18px]">
                            {payload.secureScorePoints}/{payload.secureScoreMax} pts
                          </span>
                        )}
                        {name === 'ztaScore' && payload.ztaDeviceCount > 0 && (
                          <span className="text-xs text-muted-foreground ml-[18px]">
                            {payload.ztaDeviceCount} devices assessed
                          </span>
                        )}
                      </div>
                    );
                  }}
                />
              }
            />
            <Area
              type="monotone"
                isAnimationActive={false}
              dataKey="score"
              stroke="var(--color-score)"
              strokeWidth={2}
              fill="url(#fillScore)"
              connectNulls={false}
            />
            {/* Actual score is a neutral dashed REFERENCE line (no fill) —
                it hugs the defense series, so a filled area of its own only
                muddied the plot. Secure Score is a line in the alert blue. */}
            {hasRealScore && (
              <Area
                type="monotone"
                isAnimationActive={false}
                dataKey="realScore"
                stroke="var(--color-realScore)"
                strokeWidth={1.5}
                strokeOpacity={0.75}
                strokeDasharray="6 3"
                fill="none"
              />
            )}
            {hasSecureScore && (
              <Area
                type="monotone"
                isAnimationActive={false}
                dataKey="secureScore"
                stroke="var(--color-secureScore)"
                strokeWidth={2}
                fill="none"
                connectNulls
              />
            )}
            {hasZtaScore && (
              <Area
                type="monotone"
                isAnimationActive={false}
                dataKey="ztaScore"
                stroke="var(--color-ztaScore)"
                strokeWidth={2}
                fill="none"
                connectNulls
              />
            )}
            {hasErrorRate && (
              <Area
                type="monotone"
                isAnimationActive={false}
                dataKey="errorRate"
                stroke="var(--color-errorRate)"
                strokeWidth={2}
                fill="url(#fillErrorRate)"
              />
            )}
          </AreaChart>
          </ChartContainer>
        </div>
        {hasExtraData && (
          <div className="flex items-center justify-center gap-4 pt-2 flex-shrink-0">
            {Object.entries(chartConfig)
              .filter(([key]) => key === 'score' || (key === 'realScore' && hasRealScore) || (key === 'errorRate' && hasErrorRate) || (key === 'secureScore' && hasSecureScore) || (key === 'ztaScore' && hasZtaScore))
              .map(([key, cfg]) => (
              <div key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <div
                  className="h-2.5 w-2.5 rounded-[2px]"
                  style={{ backgroundColor: cfg.color }}
                />
                <span>{cfg.label}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default memo(TrendChart);
