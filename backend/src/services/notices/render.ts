import type { NoticeKind } from './types.js';
import type { TaskResult, TaskStatus } from '../../types/agent.js';
import { formatClock, formatDual } from './window.js';

export const MAX_INLINE_HOSTS = 50;

export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface NoticeEmailData {
  kind: NoticeKind;
  runTag: string;
  timezone: string;
  trigger: string;
  startNotBefore: Date;
  pickupDeadline: Date;
  windowEnd: Date;
  dayWindow?: { start: Date; end: Date };
  tests: Array<{ name: string; severity: string; category: string; techniques: string[]; tactics: string[] }>;
  hosts: Array<{ hostname: string; os: string; online: boolean }>;
  edr: Array<{ vendor: 'Microsoft Defender' | 'CrowdStrike Falcon'; autoResolve: 'disabled' | 'dry_run' | 'enabled' }>;
  uiUrl: string;
}

export interface FinishedEmailData {
  runTag: string;
  timezone: string;
  startedAt: Date;
  finishedAt: Date;
  counts: { protected: number; unprotected: number; error: number; notRun: number };
  uiUrl: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:24px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;">
<tr><td style="background-color:#18181b;padding:20px 24px;color:#ffffff;font-size:18px;font-weight:600;">ProjectAchilles</td></tr>
${body}
<tr><td style="padding:16px 24px;background-color:#fafafa;color:#71717a;font-size:12px;">Automated message from ProjectAchilles continuous security validation.</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function row(label: string, value: string): string {
  return `<tr><td style="padding:4px 0;color:#71717a;font-size:13px;width:150px;vertical-align:top;">${escapeHtml(label)}</td><td style="padding:4px 0;color:#18181b;font-size:13px;">${value}</td></tr>`;
}

function section(heading: string, inner: string): string {
  return `<tr><td style="padding:12px 24px;"><div style="font-size:14px;font-weight:600;color:#18181b;margin-bottom:6px;">${escapeHtml(heading)}</div>${inner}</td></tr>`;
}

function edrText(e: NoticeEmailData['edr'][number]): string {
  const v = escapeHtml(e.vendor);
  switch (e.autoResolve) {
    case 'enabled':
      return `${v}: alerts raised by these tests will be auto-resolved as security testing.`;
    case 'dry_run':
      return `${v}: auto-resolve is in dry-run mode; alerts are logged but not resolved, so expect them in your queue.`;
    default:
      return `${v}: auto-resolve is disabled; alerts raised by these tests will appear in your queue.`;
  }
}

export function buildNoticeEmail(d: NoticeEmailData): { subject: string; html: string } {
  const n = plural(d.tests.length, 'test', 'tests');
  const m = plural(d.hosts.length, 'host', 'hosts');
  const subject =
    d.kind === 'day' && d.dayWindow
      ? `[ProjectAchilles] Security testing today ${formatClock(d.dayWindow.start, d.timezone)}–${formatClock(d.dayWindow.end, d.timezone)} ${d.timezone} — ${n} on ${m}`
      : `[ProjectAchilles] Security testing starts ${formatDual(d.startNotBefore, d.timezone)} — ${n} on ${m}`;

  const when: string[] = [];
  when.push(row('Reference', `<strong>${escapeHtml(d.runTag)}</strong>`));
  when.push(row('Trigger', escapeHtml(d.trigger)));
  if (d.kind === 'day' && d.dayWindow) {
    when.push(row('Testing window', `${escapeHtml(formatDual(d.dayWindow.start, d.timezone))} to ${escapeHtml(formatDual(d.dayWindow.end, d.timezone))}`));
  }
  when.push(row('Starts no earlier than', escapeHtml(formatDual(d.startNotBefore, d.timezone))));
  when.push(row('Hosts pick up until', escapeHtml(formatDual(d.pickupDeadline, d.timezone))));
  when.push(row('All activity ends by', escapeHtml(formatDual(d.windowEnd, d.timezone))));

  const testRows = d.tests
    .map(
      (t) =>
        `<tr data-row="test"><td style="padding:6px 8px;border-bottom:1px solid #e4e4e7;font-size:13px;color:#18181b;">${escapeHtml(t.name)}</td><td style="padding:6px 8px;border-bottom:1px solid #e4e4e7;font-size:12px;color:#52525b;">${escapeHtml(t.severity)} / ${escapeHtml(t.category)}</td><td style="padding:6px 8px;border-bottom:1px solid #e4e4e7;font-size:12px;color:#52525b;">${escapeHtml([...t.techniques, ...t.tactics].join(', '))}</td></tr>`,
    )
    .join('');

  const shown = d.hosts.slice(0, MAX_INLINE_HOSTS);
  const hostRows = shown
    .map((h) => {
      const status = h.online
        ? 'online'
        : `offline: will run if it reconnects before ${formatDual(d.pickupDeadline, d.timezone)}`;
      return `<tr data-row="host"><td style="padding:4px 8px;border-bottom:1px solid #e4e4e7;font-size:13px;color:#18181b;">${escapeHtml(h.hostname)}</td><td style="padding:4px 8px;border-bottom:1px solid #e4e4e7;font-size:12px;color:#52525b;">${escapeHtml(h.os)}</td><td style="padding:4px 8px;border-bottom:1px solid #e4e4e7;font-size:12px;color:#52525b;">${escapeHtml(status)}</td></tr>`;
    })
    .join('');
  const more =
    d.hosts.length > MAX_INLINE_HOSTS
      ? `<div style="font-size:12px;color:#52525b;margin-top:6px;">and ${d.hosts.length - MAX_INLINE_HOSTS} more (see attached CSV)</div>`
      : '';

  const edr = d.edr.length
    ? section(
        'Security tooling',
        d.edr.map((e) => `<div style="font-size:13px;color:#18181b;margin-bottom:4px;">${edrText(e)}</div>`).join(''),
      )
    : '';

  const body = [
    `<tr><td style="padding:20px 24px 4px;font-size:16px;font-weight:600;color:#18181b;">Security testing is about to begin</td></tr>`,
    `<tr><td style="padding:0 24px;"><table width="100%" cellpadding="0" cellspacing="0">${when.join('')}</table></td></tr>`,
    section(`Tests (${d.tests.length})`, `<table width="100%" cellpadding="0" cellspacing="0">${testRows}</table>`),
    section(`Hosts (${d.hosts.length})`, `<table width="100%" cellpadding="0" cellspacing="0">${hostRows}</table>${more}`),
    edr,
    `<tr><td style="padding:12px 24px 20px;"><a href="${escapeHtml(d.uiUrl)}" style="color:#2563eb;font-size:13px;">Open ProjectAchilles</a></td></tr>`,
  ].join('\n');

  return { subject, html: shell(subject, body) };
}

export function buildFinishedEmail(d: FinishedEmailData): { subject: string; html: string } {
  const subject = `[ProjectAchilles] Security testing finished — ${d.runTag}`;
  const c = d.counts;
  const cells = (
    [
      ['Protected', c.protected],
      ['Unprotected', c.unprotected],
      ['Error', c.error],
      ['Not run', c.notRun],
    ] as const
  )
    .map(
      ([label, n]) =>
        `<td align="center" style="padding:12px;border:1px solid #e4e4e7;"><div style="font-size:22px;font-weight:600;color:#18181b;">${n}</div><div style="font-size:12px;color:#71717a;">${label}</div></td>`,
    )
    .join('');
  const body = [
    `<tr><td style="padding:20px 24px 4px;font-size:16px;font-weight:600;color:#18181b;">Security testing has finished</td></tr>`,
    `<tr><td style="padding:0 24px;"><table width="100%" cellpadding="0" cellspacing="0">${row('Reference', `<strong>${escapeHtml(d.runTag)}</strong>`)}${row('Started', escapeHtml(formatDual(d.startedAt, d.timezone)))}${row('Finished', escapeHtml(formatDual(d.finishedAt, d.timezone)))}</table></td></tr>`,
    `<tr><td style="padding:12px 24px;"><table width="100%" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table></td></tr>`,
    `<tr><td style="padding:12px 24px 20px;"><a href="${escapeHtml(d.uiUrl)}" style="color:#2563eb;font-size:13px;">Open ProjectAchilles</a></td></tr>`,
  ].join('\n');
  return { subject, html: shell(subject, body) };
}

export function classifyOutcome(task: {
  status: TaskStatus;
  result: TaskResult | null;
}): 'protected' | 'unprotected' | 'error' | 'notRun' {
  if (task.status !== 'completed') return 'notRun';
  const code = task.result?.exit_code;
  if (code === 101) return 'unprotected';
  if (code === 105 || code === 126 || code === 127) return 'protected';
  return 'error';
}

function csvCell(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildHostsCsv(hosts: Array<{ hostname: string; os: string; online: boolean }>): string {
  const lines = ['hostname,os,online', ...hosts.map((h) => [csvCell(h.hostname), csvCell(h.os), String(h.online)].join(','))];
  return lines.join('\r\n') + '\r\n';
}
