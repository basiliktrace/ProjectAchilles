/** Helpers for the "latest result per test x endpoint" posture Defense Score. */

export const MIN_POSTURE_PAIRS = 10;
export const POSTURE_HELP =
  'Share of test × endpoint pairs whose most recent result in the selected window was blocked or detected.';

export function isLowSample(pairCount: number | null | undefined): boolean {
  return pairCount == null || pairCount < MIN_POSTURE_PAIRS;
}

/** Last non-null score minus first non-null score; null when there are no scored points. */
export function seriesDelta(points: { score: number | null }[]): number | null {
  const scored = points.filter((p) => p.score != null).map((p) => p.score as number);
  if (scored.length === 0) return null;
  return scored[scored.length - 1] - scored[0];
}

export function postureCaption(
  pairCount: number | null | undefined,
  delta: number | null,
  rangeLabel: string,
): string {
  if (isLowSample(pairCount)) return `n=${pairCount ?? 0} · not enough data`;
  const pairs = `${(pairCount as number).toLocaleString('en-US')} pairs`;
  if (delta == null) return pairs;
  const sign = delta < 0 ? '−' : '+';
  return `${pairs} · ${sign}${Math.abs(delta).toFixed(1)} pts over ${rangeLabel}`;
}

/** Prefer the trend's last point so the tile and the line can never disagree. */
export function pickCurrentScore(
  tile: { score: number | null; pairCount?: number } | null,
  trend: { score: number | null; total: number }[] | null,
): { score: number | null; pairCount: number | null } {
  if (trend && trend.length > 0) {
    const last = trend[trend.length - 1];
    return { score: last.score, pairCount: last.total };
  }
  if (tile) return { score: tile.score, pairCount: tile.pairCount ?? null };
  return { score: null, pairCount: null };
}

export function scoreTone(
  score: number | null,
  pairCount: number | null,
): 'muted' | 'danger' | 'warning' | 'accent' {
  if (score == null || isLowSample(pairCount)) return 'muted';
  if (score >= 80) return 'accent';
  if (score >= 60) return 'warning';
  return 'danger';
}
