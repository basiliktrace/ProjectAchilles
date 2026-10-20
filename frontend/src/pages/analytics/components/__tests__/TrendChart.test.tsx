// Trend timestamps are UTC day ends; labels must not drift with the viewer's zone.
process.env.TZ = 'America/Santo_Domingo';

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  const React = await import('react');
  return {
    ...actual,
    // jsdom has no layout; give the chart a fixed size so axes render.
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) =>
      React.cloneElement(children, { width: 800, height: 300 } as Record<string, unknown>),
  };
});

import TrendChart from '../TrendChart';
import type { ZtaScoreTrendPoint } from '@/services/api/crowdstrike';

const pt = (timestamp: string, score: number | null, extra: Record<string, unknown> = {}) => ({
  timestamp,
  score,
  total: 20,
  protected: 10,
  ...extra,
});

describe('TrendChart', () => {
  it('header shows the last point, not the mean', () => {
    render(
      <TrendChart
        data={[pt('2026-10-18T23:59:59.999Z', 20), pt('2026-10-19T23:59:59.999Z', 90)]}
      />,
    );
    expect(screen.getByText('Defense: 90.0%')).toBeInTheDocument();
  });

  it('skips trailing null points when picking the last value', () => {
    render(
      <TrendChart
        data={[pt('2026-10-18T23:59:59.999Z', 40), pt('2026-10-19T23:59:59.999Z', null)]}
        errorRateData={[
          { timestamp: '2026-10-18T23:59:59.999Z', errorRate: 4, errorCount: 1, conclusiveCount: 9, total: 10 },
          { timestamp: '2026-10-19T23:59:59.999Z', errorRate: null, errorCount: 0, conclusiveCount: 0, total: 0 },
        ]}
      />,
    );
    expect(screen.getByText('Error rate: 4.0%')).toBeInTheDocument();
  });

  it('shows the last realScore as Actual only when present', () => {
    const { rerender } = render(
      <TrendChart
        data={[pt('2026-10-18T23:59:59.999Z', 80, { realScore: 60 }), pt('2026-10-19T23:59:59.999Z', 82, { realScore: 65 })]}
      />,
    );
    expect(screen.getByText('Actual: 65.0%')).toBeInTheDocument();
    rerender(<TrendChart data={[pt('2026-10-19T23:59:59.999Z', 82)]} />);
    expect(screen.queryByText(/Actual/)).toBeNull();
  });

  it('ZTA with no data renders no ZTA segment and never "NaN"', () => {
    const { container } = render(
      <TrendChart
        data={[pt('2026-10-18T23:59:59.999Z', 50), pt('2026-10-19T23:59:59.999Z', 60)]}
        ztaScoreTrendData={[]}
        secureScoreTrendData={[]}
      />,
    );
    expect(container.textContent).not.toMatch(/NaN/);
    expect(container.textContent).not.toMatch(/ZTA/);
    expect(container.textContent).not.toMatch(/Secure Score:/);
  });

  it('uses the last secure and ZTA values', () => {
    const zta: ZtaScoreTrendPoint[] = [
      { date: '2026-10-18', overallScore: 70, deviceCount: 4 },
      { date: '2026-10-19', overallScore: 75.5, deviceCount: 4 },
    ];
    render(
      <TrendChart
        data={[pt('2026-10-18T23:59:59.999Z', 50), pt('2026-10-19T23:59:59.999Z', 60)]}
        secureScoreTrendData={[
          { date: '2026-10-18', score: 1, maxScore: 10, percentage: 10 },
          { date: '2026-10-19', score: 3, maxScore: 10, percentage: 30 },
        ]}
        ztaScoreTrendData={zta}
      />,
    );
    expect(screen.getByText('Secure Score: 30.0%')).toBeInTheDocument();
    expect(screen.getByText('ZTA Score: 75.5%')).toBeInTheDocument();
  });

  it('has no "rolling" text', () => {
    const { container } = render(
      <TrendChart data={[pt('2026-10-18T23:59:59.999Z', 50), pt('2026-10-19T23:59:59.999Z', 60)]} />,
    );
    expect(container.textContent).not.toMatch(/rolling/i);
  });

  it('x labels are UTC days (not shifted by the local zone)', () => {
    // 23:59:59.999Z on the 19th is still the 19th in UTC, but the 19th 19:59 local; 00:00Z on the 20th would
    // show as Oct 19 locally. Labels must come from the UTC day.
    const { container } = render(
      <TrendChart data={[pt('2026-10-19T00:00:00.000Z', 50), pt('2026-10-20T00:00:00.000Z', 60)]} />,
    );
    const ticks = Array.from(container.querySelectorAll('.recharts-xAxis .recharts-cartesian-axis-tick-value')).map(
      (n) => n.textContent,
    );
    expect(ticks).toContain('Oct 19');
    expect(ticks).toContain('Oct 20');
  });
});
