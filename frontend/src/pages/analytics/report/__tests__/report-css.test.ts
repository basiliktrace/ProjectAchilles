import { readFileSync } from 'node:fs';
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
