// Campaign timeline (spec §5.4/§5.5). Glyph mode: one column per run with
// its stages stacked. Bucket mode: one 100% outcome column per bucket. The
// choice, ticks and trend come from lib/timeline.ts; this file only draws.
import { useMemo } from 'react';

import type { ExecutionReport, ReportRun, ReportTimelineBucket } from '@/services/api/reports';
import { COUNTED_OUTCOMES, emptyCounts } from '../lib/outcomes';
import { plural, truncate } from '../lib/format';
import {
  GLYPH_GAP_PX, axisTicks, bucketMs, canUseGlyphs, coverageNote, packPositions, timeScale, trendPoints,
} from '../lib/timeline';
import { Glyph, OutcomeLegend } from './StageGlyph';

const OTHER_LANE = '__other__';
const W = 680;
const X0 = 156;
const X1 = W - 8;
const TREND_H = 60;
const GLYPH = 7;
const GLYPH_GAP = 2;
/** Above this many stages a run is drawn as one proportional bar instead of a stack. */
export const MAX_STACK = 10;
export const STACK_HEIGHT = MAX_STACK * (GLYPH + GLYPH_GAP) - GLYPH_GAP;

export function RunColumn({ run, x, top }: { run: ReportRun; x: number; top: number }) {
  if (run.stages.length <= MAX_STACK) {
    return (
      <g>
        {run.stages.map((s, i) => (
          <Glyph key={i} outcome={s.outcome} highImpact={s.highImpact} x={x - GLYPH / 2} y={top + i * (GLYPH + GLYPH_GAP)} size={GLYPH} />
        ))}
      </g>
    );
  }
  const counts = emptyCounts();
  for (const s of run.stages) counts[s.outcome] += 1;
  const present = COUNTED_OUTCOMES.filter((o) => counts[o] > 0);
  const total = present.reduce((sum, o) => sum + counts[o], 0) || 1;
  let y = top;
  return (
    <g>
      {present.map((o) => {
        const h = (counts[o] / total) * STACK_HEIGHT;
        const segment = <rect key={o} className={`rp-g rp-g-${o}`} x={x - GLYPH / 2} y={y} width={GLYPH} height={h} />;
        y += h;
        return segment;
      })}
    </g>
  );
}

function BucketColumn({ bucket, testKey, x0, x1, top, height }: {
  bucket: ReportTimelineBucket; testKey: string; x0: number; x1: number; top: number; height: number;
}) {
  const lane = bucket.lanes.find((l) => l.testKey === testKey);
  if (!lane) return null;
  // Both ends are clamped to the plot area; a bucket wholly outside it has nothing left to draw.
  if (x1 <= x0) return null;
  const present = COUNTED_OUTCOMES.filter((o) => lane.outcomes[o] > 0);
  const total = present.reduce((sum, o) => sum + lane.outcomes[o], 0);
  if (total === 0) return null;
  const width = Math.min(X1 - x0, Math.max(1.5, (x1 - x0) * 0.8));
  let y = top;
  return (
    <g>
      {present.map((o) => {
        const h = (lane.outcomes[o] / total) * height;
        const segment = <rect key={o} className={`rp-g rp-g-${o}`} x={x0} y={y} width={width} height={h} />;
        y += h;
        return segment;
      })}
    </g>
  );
}

/**
 * Glyph centres for one lane: packed apart, then pulled back from the right edge so the last
 * column stays on the axis (a run that finishes at axisTo would otherwise be pushed past X1).
 */
function packInside(xs: number[]): number[] {
  const packed = packPositions(xs);
  const out = [...packed];
  let limit = X1;
  for (const [p, i] of packed.map((p, i) => [p, i] as const).sort((a, b) => b[0] - a[0])) {
    out[i] = Math.max(X0, Math.min(p, limit));
    limit = out[i] - GLYPH_GAP_PX;
  }
  return out;
}

export function CampaignTimeline({ report }: { report: ExecutionReport }) {
  const { window: win, tz, truncation } = report.meta;
  // The backend floors axisFrom in UTC while ES buckets in the report zone, so a bucket key can
  // precede axisFrom (by up to a day, a week in week mode). Every x drawn is clamped to the plot.
  const x = useMemo(() => {
    const scale = timeScale(win.axisFrom, win.axisTo, X0, X1);
    return (t: string | number) => Math.min(X1, Math.max(X0, scale(t)));
  }, [win.axisFrom, win.axisTo]);
  // ~270 ms on a 26-year day axis, so it must not rerun on unrelated re-renders.
  const ticks = useMemo(
    () => axisTicks(win.axisFrom, win.axisTo, win.bucket, tz),
    [win.axisFrom, win.axisTo, win.bucket, tz],
  );
  const lanes = report.timeline.lanes;
  const laneKeys = new Set(lanes.map((l) => l.testKey));
  const runsByLane = new Map<string, ReportRun[]>(lanes.map((l) => [l.testKey, []]));
  for (const run of report.runs) runsByLane.get(laneKeys.has(run.testKey) ? run.testKey : OTHER_LANE)?.push(run);
  const laneXs = lanes.map((l) => (runsByLane.get(l.testKey) ?? []).map((r) => x(r.completedAt)));
  const glyphs = canUseGlyphs(laneXs, !truncation.runs);

  const laneHeight = (i: number): number => {
    if (!glyphs) return 46;
    const deepest = Math.max(1, ...(runsByLane.get(lanes[i].testKey) ?? []).map((r) => Math.min(r.stages.length, MAX_STACK)));
    return Math.max(40, deepest * (GLYPH + GLYPH_GAP) - GLYPH_GAP + 16);
  };
  const tops: number[] = [];
  let cursor = TREND_H + 16;
  lanes.forEach((_, i) => {
    tops.push(cursor);
    cursor += laneHeight(i) + 6;
  });
  const axisY = cursor;
  const trend = trendPoints(report.timeline.buckets);
  const half = bucketMs(win.bucket) / 2;
  const ty = (rate: number) => 10 + (1 - rate) * (TREND_H - 20);
  const note = coverageNote(win, tz);

  return (
    <figure className="rp-figure rp-avoid">
      <svg
        className="rp-svg"
        viewBox={`0 0 ${W} ${axisY + 18}`}
        role="img"
        aria-label={`Campaign timeline, ${glyphs ? 'one column per run' : `one column per ${win.bucket}`}`}
      >
        {lanes.map((l, i) => (
          <rect key={`lane-${l.testKey}`} className="rp-lane" x={X0} y={tops[i]} width={X1 - X0} height={laneHeight(i)} />
        ))}
        {ticks.map((t) => (
          <g key={`tick-${t.t}`}>
            <line className="rp-grid" x1={x(t.t)} x2={x(t.t)} y1={TREND_H + 10} y2={axisY - 4} />
            <text className="rp-tick" stroke="none" x={x(t.t)} y={axisY + 8} textAnchor="middle">{t.label}</text>
          </g>
        ))}
        <text className="rp-lab" stroke="none" x={0} y={20}>Stage protection rate</text>
        <text className="rp-sub" stroke="none" x={0} y={32}>per {win.bucket}</text>
        {[0, 0.5, 1].map((v) => (
          <g key={`grid-${v}`}>
            <line className="rp-grid" x1={X0} x2={X1} y1={ty(v)} y2={ty(v)} />
            <text className="rp-tick" stroke="none" x={X0 - 4} y={ty(v) + 3} textAnchor="end">{v * 100}%</text>
          </g>
        ))}
        {trend.length >= 2 ? (
          <>
            <polyline className="rp-trend" points={trend.map((p) => `${x(p.t + half).toFixed(1)},${ty(p.rate).toFixed(1)}`).join(' ')} />
            {trend.map((p) => <circle key={`pt-${p.t}`} className="rp-trend-pt" cx={x(p.t + half)} cy={ty(p.rate)} r={2.5} />)}
          </>
        ) : (
          <text className="rp-sub" stroke="none" x={X0 + 8} y={TREND_H / 2 + 4}>Too few results per {win.bucket} to draw a trend</text>
        )}
        {lanes.map((l, i) => {
          const runs = runsByLane.get(l.testKey) ?? [];
          const packed = packInside(laneXs[i]);
          return (
            <g key={`marks-${l.testKey}`}>
              <text className="rp-lab" stroke="none" x={0} y={tops[i] + 14}>{truncate(l.name, 28)}</text>
              <text className="rp-sub" stroke="none" x={0} y={tops[i] + 26}>{plural(l.runs, 'run')}</text>
              {glyphs
                ? runs.map((r, j) => <RunColumn key={r.key} run={r} x={packed[j]} top={tops[i] + 8} />)
                : report.timeline.buckets.map((b) => (
                    <BucketColumn
                      key={b.start}
                      bucket={b}
                      testKey={l.testKey}
                      x0={x(b.start)}
                      x1={x(Date.parse(b.start) + bucketMs(win.bucket))}
                      top={tops[i] + 6}
                      height={laneHeight(i) - 12}
                    />
                  ))}
            </g>
          );
        })}
      </svg>
      <figcaption className="rp-caption">
        {glyphs ? 'One column per run, placed at its completion time; stages top to bottom.' : `One column per ${win.bucket}, split by stage outcome.`}
        {note ? ` ${note}` : ''}
      </figcaption>
      <OutcomeLegend highImpact />
    </figure>
  );
}
