import { describe, it, expect } from 'vitest';
import { buildNoticeEmail, buildFinishedEmail, classifyOutcome, buildHostsCsv, escapeHtml, type NoticeEmailData } from '../render.js';
import type { TaskResult } from '../../../types/agent.js';

const mk = (o: Partial<NoticeEmailData> = {}): NoticeEmailData => ({
  kind: 'run', runTag: 'PA-RUN-7f3c9a', timezone: 'America/Santo_Domingo', trigger: 'Run now by admin',
  startNotBefore: new Date('2026-10-23T13:05:00Z'), pickupDeadline: new Date('2026-10-23T15:05:00Z'),
  windowEnd: new Date('2026-10-23T15:10:00Z'),
  tests: [
    { name: 'Test A', uuid: 'c37d6a01-3934-4e72-9cb1-3dae284b937b', stages: '3', techniques: ['T1486'], tactics: ['impact'] },
    { name: 'Test B', uuid: '078f1409-9f7b-4492-bb35-3fd596e85ce0', stages: '52 controls', techniques: ['T1059.001'], tactics: [] },
  ],
  hosts: [{ hostname: 'host-1', os: 'windows', online: true }],
  edr: [], uiUrl: 'http://localhost:5173', ...o,
});
const hosts = (n: number) => Array.from({ length: n }, (_, i) => ({ hostname: `h${i}`, os: 'linux', online: true }));

describe('buildNoticeEmail', () => {
  it('subject and content', () => {
    const e = buildNoticeEmail(mk());
    expect(e.subject).toContain('2 tests on 1 host');
    expect(e.subject).toContain('2026-10-23 09:05 AST (13:05 UTC)');
    for (const s of ['PA-RUN-7f3c9a', 'T1486', 'T1059.001', 'host-1']) expect(e.html).toContain(s);
  });
  it('brands the header as ProjectAchilles | f0_csv but keeps the subject prefix', () => {
    const e = buildNoticeEmail(mk());
    expect(e.html).toContain('ProjectAchilles | f0_csv');
    expect(e.subject.startsWith('[ProjectAchilles] ')).toBe(true);
  });
  it('tests table: headers, UUID under each name, stage column instead of severity/category', () => {
    const html = buildNoticeEmail(mk()).html;
    for (const h of ['>Test<', '>Stages<', '>Techniques &amp; tactics<', '>Host<', '>OS<', '>Status<']) expect(html).toContain(h);
    expect(html).toContain('c37d6a01-3934-4e72-9cb1-3dae284b937b');
    expect(html).toContain('>3<');
    expect(html).toContain('>52 controls<');
    expect(html).not.toContain('high /');
    expect(html).not.toContain('intel-driven');
  });
  it('tells the SOC what to search for: test UUIDs under the agent task folder, not the run tag', () => {
    const html = buildNoticeEmail(mk()).html;
    expect(html).toContain('Finding this activity in your security tools');
    expect(html).toContain('C:\\F0\\tasks');
    expect(html).toContain('/opt/f0/tasks');
    expect(html).toContain('c37d6a01-3934-4e72-9cb1-3dae284b937b.exe');
    expect(html).toContain('PA-RUN-7f3c9a identifies this run in ProjectAchilles only; it does not appear on the hosts.');
  });
  it('singular test', () => {
    expect(buildNoticeEmail(mk({ tests: [mk().tests[0]] })).subject).toContain('1 test on 1 host');
  });
  it('day subject', () => {
    const e = buildNoticeEmail(mk({ kind: 'day', dayWindow: { start: new Date('2026-10-23T13:00:00Z'), end: new Date('2026-10-23T21:00:00Z') } }));
    expect(e.subject).toContain('Security testing today 09:00–17:00 America/Santo_Domingo');
  });
  it('escapes everything', () => {
    const e = buildNoticeEmail(mk({
      tests: [{ name: '<script>alert(1)</script>', uuid: '<i>u</i>', stages: '<i>1</i>', techniques: [], tactics: [] }],
      uiUrl: 'http://x/"><script>y</script>',
      hosts: [{ hostname: '<b>h</b>', os: 'linux', online: true }],
    }));
    expect(e.html).not.toContain('<script>');
    expect(e.html).not.toContain('<b>h</b>');
    expect(e.html).not.toContain('<i>');
    expect(e.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
  it('EDR wording', () => {
    const en = buildNoticeEmail(mk({ edr: [{ vendor: 'Microsoft Defender', autoResolve: 'enabled' }] }));
    expect(en.html).toContain('Microsoft Defender');
    expect(en.html).toContain('auto-resolved as security testing');
    const dry = buildNoticeEmail(mk({ edr: [{ vendor: 'CrowdStrike Falcon', autoResolve: 'dry_run' }] }));
    expect(dry.html).toContain('dry-run');
    expect(dry.html).not.toContain('auto-resolved as security testing');
    const none = buildNoticeEmail(mk());
    expect(none.html).not.toContain('Microsoft Defender');
    expect(none.html).not.toContain('CrowdStrike');
  });
  it('caps inline hosts at 50', () => {
    const e = buildNoticeEmail(mk({ hosts: hosts(60) }));
    expect(e.html.match(/data-row="host"/g)).toHaveLength(50);
    expect(e.html).toContain('and 10 more (see attached CSV)');
    expect(buildNoticeEmail(mk({ hosts: hosts(50) })).html).not.toContain('more (see attached CSV)');
  });
  it('offline host wording', () => {
    const e = buildNoticeEmail(mk({ hosts: [{ hostname: 'o', os: 'linux', online: false }] }));
    expect(e.html).toContain('will run if it reconnects before');
  });
});

describe('buildFinishedEmail', () => {
  it('subject and counts', () => {
    const e = buildFinishedEmail({ runTag: 'PA-RUN-abc123', timezone: 'UTC', startedAt: new Date(), finishedAt: new Date(), counts: { protected: 3, prevented: 0, detected: 0, unprotected: 1, error: 0, notRun: 2 }, uiUrl: 'http://u' });
    expect(e.subject).toBe('[ProjectAchilles] Security testing finished — PA-RUN-abc123');
    expect(e.html).toContain('>3<');
    expect(e.html).toContain('ProjectAchilles | f0_csv');
  });
});

describe('classifyOutcome', () => {
  const r = (exit_code: number) => ({ exit_code }) as TaskResult;
  it('maps exit codes', () => {
    expect(classifyOutcome({ status: 'completed', result: r(101) })).toBe('unprotected');
    for (const c of [105, 126, 127]) expect(classifyOutcome({ status: 'completed', result: r(c) })).toBe('protected');
    expect(classifyOutcome({ status: 'completed', result: r(0) })).toBe('error');
    expect(classifyOutcome({ status: 'completed', result: null })).toBe('error');
    expect(classifyOutcome({ status: 'expired', result: null })).toBe('notRun');
    expect(classifyOutcome({ status: 'failed', result: r(101) })).toBe('notRun');
  });
});

describe('buildHostsCsv', () => {
  it('quotes per RFC 4180', () => {
    const csv = buildHostsCsv([{ hostname: 'a,b', os: 'linux', online: true }, { hostname: 'q"x', os: 'linux', online: false }]);
    expect(csv.startsWith('hostname,os,online\r\n')).toBe(true);
    expect(csv).toContain('"a,b",linux,true');
    expect(csv).toContain('"q""x",linux,false');
  });
  it('neutralises spreadsheet formulas in cells', () => {
    const csv = buildHostsCsv([
      { hostname: '=HYPERLINK("http://evil","x")', os: '+cmd', online: true },
      { hostname: '-2+3', os: '@SUM(A1)', online: false },
      { hostname: '\tTAB', os: '\rCR', online: true },
      { hostname: 'safe-host', os: 'linux', online: true },
    ]);
    const lines = csv.split('\r\n');
    expect(lines[1]).toBe(`"'=HYPERLINK(""http://evil"",""x"")",'+cmd,true`);
    expect(lines[2]).toBe(`'-2+3,'@SUM(A1),false`);
    expect(lines[3]).toBe(`'\tTAB,"'\rCR",true`);
    expect(lines[4]).toBe('safe-host,linux,true');
  });
});

it('escapeHtml', () => expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;'));
