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

export function fmtPct(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
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
