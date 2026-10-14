import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// Read from disk, as styles/__tests__/chartTokens.css.test.ts does. A `?raw` import of a
// .css file returns '' under this Vitest setup, which would make the checks below pass vacuously.
const __dirname = dirname(fileURLToPath(import.meta.url));
const reportCss = readFileSync(resolve(__dirname, '..', 'report.css'), 'utf8');

// Chromium evaluates a print page's max-width against the content box (about 688 px on
// A4 with 14 mm margins), so a bare max-width query also matches print and reflows the
// KPI row and the two-up cards. Every narrow-screen query must therefore be screen-only.
const MEDIA_PRELUDE = /@media([^{]*)\{/g;

function mediaPreludes(css: string): string[] {
  return [...css.matchAll(MEDIA_PRELUDE)].map((m) => m[1].trim());
}

describe('report.css media queries', () => {
  const widthQueries = mediaPreludes(reportCss).filter((p) => p.includes('max-width'));

  it('has a narrow-screen query for the test to cover', () => {
    expect(widthQueries.length).toBeGreaterThan(0);
  });

  it('limits every max-width query to screen so print never takes the phone layout', () => {
    for (const prelude of widthQueries) {
      expect(prelude, `@media ${prelude}`).toMatch(/\bscreen\b/);
    }
  });
});

describe('report.css scope', () => {
  it('declares no @page rule: ReportDocument injects them and removes them on unmount', () => {
    // report.css stays loaded after the user leaves the report, so a global @page would
    // change how every other page prints.
    const rules = reportCss.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).not.toMatch(/@page\b/);
  });

  it('is imported only by the lazy report page, never by main.tsx or the global styles', () => {
    const srcDir = resolve(__dirname, '..', '..', '..', '..');
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(tsx?|css)$/.test(entry.name) && /report\.css['"]/.test(readFileSync(full, 'utf8'))) {
          importers.push(full.slice(srcDir.length + 1));
        }
      }
    };
    walk(srcDir);
    // The route's module is lazy-loaded, so importing there keeps the stylesheet out of main.tsx and styles/.
    expect(importers.filter((f) => !f.endsWith('__tests__/report-css.test.ts'))).toEqual(['pages/analytics/report/AnalyticsReportPage.tsx']);
  });
});

/** Every style rule as its selector list and declarations; rules inside @media blocks are included. */
function styleRules(css: string): Array<{ selectors: string[]; body: string }> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].split(',').map((sel) => sel.trim().replace(/\s+/g, ' ')),
    body: m[2],
  }));
}

/** The declarations of every rule that lists `selector` exactly. */
const declarationsFor = (selector: string) =>
  styleRules(reportCss).filter((r) => r.selectors.includes(selector)).map((r) => r.body).join(';');

describe('report.css page breaks', () => {
  it('keeps a subsection heading with what follows it', () => {
    // Without this a heading can print alone at the foot of a page, its chart on the next.
    const h3 = declarationsFor('.report-print .rp-h3');
    expect(h3).toMatch(/(^|;|\s)break-after:\s*avoid/);
    expect(h3).toMatch(/page-break-after:\s*avoid/);
  });
});

describe('report.css table cells', () => {
  // One unbreakable cell wider than the page makes Chromium scale the whole PDF down.
  it('lets identifier cells (hostnames, control ids, technique lists) wrap', () => {
    const monoRules = styleRules(reportCss).filter((r) => r.selectors.some((sel) => /td\.rp-mono\b/.test(sel)));
    for (const r of monoRules) expect(r.body, r.selectors.join(', ')).not.toMatch(/white-space:\s*nowrap/);
    const id = declarationsFor('.report-print .rp-table td.rp-id');
    expect(id).toMatch(/overflow-wrap:\s*anywhere/);
    expect(id).not.toMatch(/white-space:\s*nowrap/);
  });

  it('keeps numbers and dates on one line', () => {
    expect(declarationsFor('.report-print .rp-table td.rp-num')).toMatch(/white-space:\s*nowrap/);
    expect(declarationsFor('.report-print .rp-table td.rp-nowrap')).toMatch(/white-space:\s*nowrap/);
  });

  it('keeps a 15-character NetBIOS name whole: the identifier column reserves 15ch of content width', () => {
    // min-width is border-box under the app's global box-sizing, so the cell's 12px of padding
    // would come out of the 15ch and leave room for only about 13.8 characters.
    const id = declarationsFor('.report-print .rp-table td.rp-id');
    const contentBox = /box-sizing:\s*content-box/.test(id) && /min-width:\s*15ch/.test(id);
    const paddedCalc = /min-width:\s*calc\(\s*15ch\s*\+\s*12px\s*\)/.test(id);
    expect(contentBox || paddedCalc, id).toBe(true);
    // Longer names still wrap inside the cell instead of widening the table.
    expect(id).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('lets the first-alert cell wrap between its words, right-aligned like a number', () => {
    // A latency plus a vendor name on one unbreakable line made the Execution log wider than A4.
    const wrap = declarationsFor('.report-print .rp-table td.rp-num-wrap');
    expect(wrap).toMatch(/white-space:\s*normal/);
    expect(wrap).not.toMatch(/white-space:\s*nowrap/);
    const aligned = declarationsFor('.report-print .rp-table .rp-num-wrap');
    expect(aligned).toMatch(/text-align:\s*right/);
    expect(aligned).toMatch(/font-family:\s*var\(--rp-mono\)/);
  });
});

describe('report.css glyph rows', () => {
  it('puts the "+N (+M not fetched)" note on its own unbreakable line below the glyphs', () => {
    // Beside the row, the note widened the Stages cell past what A4 leaves for it.
    const more = declarationsFor('.report-print .rp-more');
    expect(more).toMatch(/display:\s*block/);
    expect(more).toMatch(/white-space:\s*nowrap/);
    expect(declarationsFor('.report-print .rp-glyph-row')).toMatch(/display:\s*inline-flex/);
  });
});
