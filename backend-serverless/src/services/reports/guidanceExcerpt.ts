// Best-effort remediation excerpt from a test's DEFENSE_GUIDANCE.md (spec §5.6).
// The library has no single format: 14/50 files key H3/H4 headings by
// technique id, 27/50 have technique-led table rows, the rest are free-form,
// and cyber-hygiene tests have no guidance at all. First match wins:
//   1. an H2–H4 heading containing the technique id → that section's prose
//      (fenced code blocks are dropped, and a `#` inside one is not a heading;
//      a section with no prose left is skipped)
//   2. a table row that names the technique in one cell and a mitigation id
//      (M####) in another → its other cells. A row without a mitigation is a
//      technique description ("what the test does"), not remediation.
//   3. otherwise null (the report prints a pointer to the file instead)

import fs from 'fs';
import path from 'path';
import { FileService } from '../browser/fileService.js';

export const EXCERPT_MAX_CHARS = 600;

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^(```|~~~)/;
const MITIGATION_ID = /\bM\d{4}\b/;

/** Technique id as a whole token: T1059 must not match T1059.001. */
function techniquePattern(id: string): RegExp {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9.])${escaped}(?![0-9]|\\.[0-9])`, 'i');
}

export function markdownToPlain(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*\d+\.\s+/gm, '• ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return `${cut.slice(0, lastBreak > max * 0.6 ? lastBreak : cut.length).trimEnd()}…`;
}

/** Per line: true for fence marker lines and everything between them. */
function fencedLines(lines: string[]): boolean[] {
  let open = false;
  return lines.map((line) => {
    const marker = FENCE.test(line.trimStart());
    const fenced = open || marker;
    if (marker) open = !open;
    return fenced;
  });
}

export function extractGuidanceExcerpt(markdown: string, techniqueId: string): string | null {
  const pattern = techniquePattern(techniqueId);
  const lines = markdown.split(/\r?\n/);
  const fenced = fencedLines(lines);

  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const heading = lines[i].match(HEADING);
    if (!heading || heading[1].length < 2 || heading[1].length > 4) continue;
    if (!pattern.test(markdownToPlain(heading[2]))) continue;
    const level = heading[1].length;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (fenced[j]) continue;
      const next = lines[j].match(HEADING);
      if (next && next[1].length <= level) break;
      if (lines[j].trim() !== '' && !/^\s*\|?\s*:?-{3,}/.test(lines[j])) body.push(lines[j]);
    }
    const text = markdownToPlain(body.join('\n'));
    if (text) return truncate(text, EXCERPT_MAX_CHARS);
  }

  for (const line of lines) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim()).filter((c) => c !== '').map(markdownToPlain);
    const rest = cells.filter((c) => !pattern.test(c));
    if (rest.length === cells.length || !rest.some((c) => MITIGATION_ID.test(c))) continue;
    return truncate(rest.join(' · '), EXCERPT_MAX_CHARS);
  }

  return null;
}

/** Contents of <testDir>/<uuid>_DEFENSE_GUIDANCE.md, or null if absent/unreadable. */
export function readDefenseGuidance(testDir: string, uuid: string): string | null {
  const file = path.join(testDir, `${uuid}_DEFENSE_GUIDANCE.md`);
  if (!fs.existsSync(file)) return null;
  try {
    return FileService.readFileContent(file).content;
  } catch {
    return null;
  }
}
