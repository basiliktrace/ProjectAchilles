import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractGuidanceExcerpt, readDefenseGuidance, markdownToPlain, EXCERPT_MAX_CHARS } from '../guidanceExcerpt.js';

// Fixtures modeled on the three real formats in f0_library:
//   heading-keyed  — 414a4c61 "### T1204.002 - User Execution: Malicious File"
//   table-keyed    — 298cc137 "| [T1486](…) — Data Encrypted for Impact | Impact | [M1040](…) … |"
//   free-form      — 0a749b39 "## 1. Prevention / ### 1.1 …"
const HEADING_KEYED = `# Defense Guidance

## Defensive Recommendations by Technique

### T1204.002 - User Execution: Malicious File

**Prevention:**
- Enable Microsoft Defender SmartScreen for PDF and executable downloads
- Implement Mark of the Web (MOTW) enforcement for downloaded files

**Detection:**
- Alert on PDF files with OpenAction URI references to executable downloads

### T1059.001 - PowerShell (Download Cradle)

**Prevention:**
- Enable Constrained Language Mode

## Incident Response Playbook

Contain the host.
`;

const TABLE_KEYED = `## MITRE ATT&CK Mapping

| Technique | Tactic | Applicable Mitigations |
|-----------|--------|------------------------|
| [T1059.001](https://attack.mitre.org/techniques/T1059/001/) — PowerShell | Execution | [M1042](https://attack.mitre.org/mitigations/M1042/) Disable/Remove Feature, [M1045](https://attack.mitre.org/mitigations/M1045/) Code Signing |
| [T1486](https://attack.mitre.org/techniques/T1486/) — Data Encrypted for Impact | Impact | [M1040](https://attack.mitre.org/mitigations/M1040/) Behavior Prevention on Endpoint (ASR ransomware rule, Controlled Folder Access) |
`;

const FREE_FORM = `## 1. Prevention

### 1.1 Disable WSH on systems that don't need it

Set the registry value to disable Windows Script Host.

## 2. Detection
`;

// Real files (e.g. 92b0b4f6) put a fenced PowerShell block straight after the
// technique heading, and its first line is a `# comment`.
const FENCED = `### T1547.001 - Registry Run Keys

\`\`\`powershell
# comment inside the fence
auditpol /set /subcategory:"Registry" /success:enable
\`\`\`

Review the audit events weekly.

### T1555.003 - Credentials from Web Browsers

Restrict browser credential stores.
`;

const FENCE_ONLY = `### T1486 - Data Encrypted for Impact

~~~bash
# only a script lives here
echo hardening
~~~

### T1490 - Inhibit System Recovery

Protect shadow copies.
`;

const MITIGATION_TABLE = `| Mitigation | Name | Techniques | Guidance |
|------------|------|------------|----------|
| M1040 | Behavior Prevention on Endpoint | T1486 | Enable ransomware protection |
`;

describe('extractGuidanceExcerpt', () => {
  it('returns the section under a technique-keyed heading, as plain text', () => {
    const excerpt = extractGuidanceExcerpt(HEADING_KEYED, 'T1204.002');
    expect(excerpt).toContain('Prevention:');
    expect(excerpt).toContain('• Enable Microsoft Defender SmartScreen');
    expect(excerpt).toContain('Detection:');
    expect(excerpt).not.toContain('Constrained Language Mode');
    expect(excerpt).not.toContain('**');
  });

  it('stops at the next heading of the same or higher level', () => {
    const excerpt = extractGuidanceExcerpt(HEADING_KEYED, 'T1059.001');
    expect(excerpt).toContain('Enable Constrained Language Mode');
    expect(excerpt).not.toContain('Contain the host');
  });

  it('does not let a parent technique match a sub-technique', () => {
    expect(extractGuidanceExcerpt(HEADING_KEYED, 'T1059')).toBeNull();
    expect(extractGuidanceExcerpt(TABLE_KEYED, 'T1059')).toBeNull();
  });

  it('falls back to a technique-led table row', () => {
    expect(extractGuidanceExcerpt(TABLE_KEYED, 'T1486')).toBe(
      'Impact · M1040 Behavior Prevention on Endpoint (ASR ransomware rule, Controlled Folder Access)',
    );
  });

  it('returns null for free-form guidance', () => {
    expect(extractGuidanceExcerpt(FREE_FORM, 'T1059.003')).toBeNull();
  });

  it(`truncates to ${EXCERPT_MAX_CHARS} characters with an ellipsis`, () => {
    const long = `### T1486 - Data Encrypted for Impact\n\n${'- Enable controlled folder access everywhere\n'.repeat(40)}`;
    const excerpt = extractGuidanceExcerpt(long, 'T1486')!;
    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS);
    expect(excerpt.endsWith('…')).toBe(true);
  });
});

describe('extractGuidanceExcerpt: code fences', () => {
  it('keeps the prose after a fenced block and drops the fenced content', () => {
    const excerpt = extractGuidanceExcerpt(FENCED, 'T1547.001');
    expect(excerpt).toBe('Review the audit events weekly.');
    expect(excerpt).not.toContain('`');
    expect(excerpt).not.toContain('comment');
    expect(excerpt).not.toContain('auditpol');
  });

  it('does not let a fenced # line end the section or start a candidate heading', () => {
    const md = `### T1486 - Data Encrypted for Impact\n\nBefore.\n\n\`\`\`\n# T1490 backup\n# next\n\`\`\`\n\nAfter.\n`;
    expect(extractGuidanceExcerpt(md, 'T1486')).toBe('Before.\nAfter.');
    expect(extractGuidanceExcerpt(md, 'T1490')).toBeNull();
  });

  it('falls through to the table fallback when a heading section is only a fenced block', () => {
    expect(extractGuidanceExcerpt(FENCE_ONLY + MITIGATION_TABLE, 'T1486')).toBe(
      'M1040 · Behavior Prevention on Endpoint · Enable ransomware protection',
    );
  });

  it('returns null when a heading section is only a fenced block and there is no table', () => {
    expect(extractGuidanceExcerpt(FENCE_ONLY, 'T1486')).toBeNull();
  });
});

describe('extractGuidanceExcerpt: tables inside a heading section', () => {
  // Real files (e.g. 244dfb88) put a settings table straight under the technique heading.
  const SECTION_TABLE = `### T1553.001 - Gatekeeper Bypass

| Setting | Value | Notes |
|:--------|------:|-------|
| Mitigation | [M1038](https://x) Execution Prevention | **required** |
| \`spctl\` | --master-enable | run as root |

Audit weekly.
`;

  it('flattens table rows to their cells and drops the header and separator rows', () => {
    const excerpt = extractGuidanceExcerpt(SECTION_TABLE, 'T1553.001');
    expect(excerpt).toBe('Mitigation · M1038 Execution Prevention · required\nspctl · --master-enable · run as root\nAudit weekly.');
    expect(excerpt).not.toContain('|');
    expect(excerpt).not.toContain('Setting');
  });
});

describe('extractGuidanceExcerpt: table rows', () => {
  it('rejects a description-only row with no mitigation id', () => {
    const details = '| Technique | Name | Tactic | Test action |\n|---|---|---|---|\n| T1486 | Data Encrypted for Impact | Impact | File encryption |\n';
    expect(extractGuidanceExcerpt(details, 'T1486')).toBeNull();
  });

  it('accepts a mitigation-led row and drops only the technique cell', () => {
    expect(extractGuidanceExcerpt(MITIGATION_TABLE, 'T1486')).toBe(
      'M1040 · Behavior Prevention on Endpoint · Enable ransomware protection',
    );
  });

  it('skips a description-only row to reach a later row that has a mitigation', () => {
    const md = '| T1486 | Data Encrypted for Impact | Impact | File encryption |\n' + MITIGATION_TABLE;
    expect(extractGuidanceExcerpt(md, 'T1486')).toBe(
      'M1040 · Behavior Prevention on Endpoint · Enable ransomware protection',
    );
  });

  it('keeps whole-token matching for mitigation-led rows', () => {
    expect(extractGuidanceExcerpt(MITIGATION_TABLE, 'T148')).toBeNull();
    expect(extractGuidanceExcerpt(MITIGATION_TABLE.replace('T1486', 'T1486.001'), 'T1486')).toBeNull();
  });
});

describe('markdownToPlain', () => {
  it('strips links, emphasis, code and list markers', () => {
    expect(markdownToPlain('- **Bold** [M1040](https://x) `cmd`\n1. step')).toBe('• Bold M1040 cmd\n• step');
  });
});

describe('readDefenseGuidance', () => {
  const dirs: string[] = [];
  const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'guidance-')); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it('reads <uuid>_DEFENSE_GUIDANCE.md from the test directory', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'abc_DEFENSE_GUIDANCE.md'), TABLE_KEYED);
    expect(readDefenseGuidance(dir, 'abc')).toBe(TABLE_KEYED);
  });

  it('returns null when the file is missing', () => {
    expect(readDefenseGuidance(tmp(), 'abc')).toBeNull();
  });

  it('returns null when the file cannot be read', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'abc_DEFENSE_GUIDANCE.md')); // a directory, not a file
    expect(readDefenseGuidance(dir, 'abc')).toBeNull();
  });

  it('returns null when the file is larger than the 5 MB read limit', () => {
    const dir = tmp();
    const file = path.join(dir, 'abc_DEFENSE_GUIDANCE.md');
    fs.writeFileSync(file, '');
    fs.truncateSync(file, 5 * 1024 * 1024 + 1); // sparse, one byte over the limit
    expect(readDefenseGuidance(dir, 'abc')).toBeNull();
  });
});
