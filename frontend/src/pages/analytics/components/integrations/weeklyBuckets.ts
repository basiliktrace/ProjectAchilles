// Bucket daily execution points to match the alert trend's bucket width.

/** Monday (UTC) of the week containing `ts`, as YYYY-MM-DD. Matches ES calendar_interval: week. */
export function isoWeekStart(ts: string): string {
  const d = new Date(ts.length <= 10 ? `${ts}T00:00:00Z` : ts);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** Sum execution totals by bucket start date (`day` = the date itself). */
export function bucketExecutions(
  points: Array<{ timestamp: string; total?: number }>,
  interval: 'day' | 'week',
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of points) {
    const key = interval === 'week' ? isoWeekStart(p.timestamp) : p.timestamp.slice(0, 10);
    out[key] = (out[key] ?? 0) + (p.total ?? 0);
  }
  return out;
}
