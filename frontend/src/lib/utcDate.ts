/** UTC-stable date helpers: trend timestamps are UTC day ends, so never use local time. */

function toDate(ts: string | number): Date {
  if (typeof ts === 'string' && /^\d+$/.test(ts.trim())) return new Date(Number(ts));
  return new Date(ts);
}

/** 'YYYY-MM-DD' in UTC. Numeric strings are epoch ms. */
export function utcDayKey(ts: string | number): string {
  const d = toDate(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

const SHORT = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
const LONG = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });

/** 'Oct 13' (short) or 'Oct 13, 2026' (long), in UTC. */
export function formatUtcDay(ts: string | number, style: 'short' | 'long' = 'short'): string {
  const d = toDate(ts);
  if (Number.isNaN(d.getTime())) return '';
  return (style === 'long' ? LONG : SHORT).format(d);
}
