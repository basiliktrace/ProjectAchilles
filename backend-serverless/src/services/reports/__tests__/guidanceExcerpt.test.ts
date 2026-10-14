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
