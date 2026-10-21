import type { TestMetadata } from '@/types/test';

export interface TestStats {
  total: number;
  /** Tests in the intel-driven category (threat-actor emulations). */
  intelDriven: number;
  avgScore: number;
  scoredTests: number;
}

export function computeTestStats(tests: TestMetadata[]): TestStats {
  const scores = tests.map((t) => t.score).filter((s): s is number => s != null && s > 0);
  const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

  return {
    total: tests.length,
    intelDriven: tests.filter((t) => t.category === 'intel-driven').length,
    avgScore,
    scoredTests: scores.length,
  };
}
