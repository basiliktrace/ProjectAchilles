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
