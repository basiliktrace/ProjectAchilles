// Formatting for the execution report. Every time is shown in the report's
// zone (meta.tz). Month names are built from en-US parts so output does not
// depend on locale data (en-GB's "Sept" varies by ICU version).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(iso: string, tz: string, opts: Intl.DateTimeFormatOptions): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]),
  );
}

function dayMonthYear(iso: string, tz: string) {
  const p = parts(iso, tz, { day: 'numeric', month: 'numeric', year: 'numeric' });
  return { day: Number(p.day), month: MONTHS[Number(p.month) - 1], year: p.year };
}

export function fmtDate(iso: string, tz: string): string {
  const d = dayMonthYear(iso, tz);
  return `${d.day} ${d.month} ${d.year}`;
}

export function fmtShortDate(iso: string, tz: string): string {
  const d = dayMonthYear(iso, tz);
  return `${d.day} ${d.month}`;
}

export function fmtTime(iso: string, tz: string, withSeconds = false): string {
  const p = parts(iso, tz, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  return withSeconds ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`;
}

export function fmtDateTime(iso: string, tz: string): string {
  return `${fmtDate(iso, tz)}, ${fmtTime(iso, tz)}`;
}

/** Short zone name for the cover, e.g. "AST" or "UTC". */
export function tzName(iso: string, tz: string): string {
  return parts(iso, tz, { timeZoneName: 'short' }).timeZoneName ?? tz;
}

/**
 * Whole-percent rate, truncated: 0.7496 reads 74%, never 75%. Truncating never overstates
 * protection and agrees with bandOf's thresholds and the backend's < 0.75 findings ceiling.
 * A partial rate is clamped to 1–99, so 299 of 300 reads 99% and 1 of 300 reads 1%; exactly
 * 0 and exactly 1 keep their endpoints.
 */
export function fmtPct(rate: number | null): string {
  if (rate === null) return '—';
  if (rate <= 0) return '0%';
  if (rate >= 1) return '100%';
  // The epsilon absorbs binary floating point (0.29 * 100 is 28.999999999999996) without
  // lifting any real rate: a count-based rate sits far more than 1e-9 below the next percent.
  return `${Math.min(99, Math.max(1, Math.floor(rate * 100 + 1e-9)))}%`;
}

export function fmtCount(n: number, approximate = false): string {
  const s = n.toLocaleString('en-US');
  return approximate ? `about ${s}` : s;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Signed latency, e.g. +1m 02s, −45s, +2h 05m. */
export function fmtLatency(seconds: number): string {
  const sign = seconds < 0 ? '−' : '+';
  let s = Math.round(Math.abs(seconds));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (h > 0) return `${sign}${h}h ${pad(m)}m`;
  if (m > 0) return `${sign}${m}m ${pad(s)}s`;
  return `${sign}${s}s`;
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}
