import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReportRun, ReportRunStage } from '@/services/api/reports';
import { CampaignTimeline, MAX_STACK, RunColumn } from '../CampaignTimeline';
import { axisTicks } from '../../lib/timeline';
import { BUNDLE, counts, makeReport, makeRun, makeWindow } from '../../__tests__/fixtures';

// Wrap (not replace) axisTicks so the memoisation test can count calls.
vi.mock('../../lib/timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/timeline')>();
  return { ...actual, axisTicks: vi.fn(actual.axisTicks) };
});

/** Mirrors the diagram's plot area: X0 = 156, X1 = 680 - 8. */
const X0 = 156;
const X1 = 672;

const stage = (i: number, outcome: ReportRunStage['outcome']): ReportRunStage => ({
  controlId: `CH-${i}`, name: `Control ${i}`, order: i + 1, outcome,
  exitCode: null, techniques: [], tactics: [], highImpact: false,
});

const num = (el: Element, attr: string) => Number(el.getAttribute(attr));

describe('CampaignTimeline', () => {
  it('draws one column per run when runs are sparse and the list is complete', () => {
    render(<CampaignTimeline report={makeReport()} />);
    expect(screen.getByRole('img', { name: /one column per run/ })).toBeInTheDocument();
    expect(screen.getByText(/One column per run, placed at its completion time/)).toBeInTheDocument();
  });

  it('switches to buckets when the runs list is truncated', () => {
    render(<CampaignTimeline report={makeReport({ meta: { truncation: { runs: true, tests: false, lanes: false } } })} />);
    expect(screen.getByText(/One column per day, split by stage outcome/)).toBeInTheDocument();
  });

  it('replaces the trend line when buckets are too sparse', () => {
    render(<CampaignTimeline report={makeReport()} />);
    expect(screen.getByText('Too few results per day to draw a trend')).toBeInTheDocument();
  });

  it('shows the coverage note when executions fill little of the window', () => {
    render(<CampaignTimeline report={makeReport()} />);
    expect(screen.getByText(/Executions only between/)).toBeInTheDocument();
  });

  it('draws a 30-control bundle as one proportional bar, not a stack (Review Focus #1)', () => {
    const big = makeRun({
      stages: Array.from({ length: 30 }, (_, i) => stage(i, i < 20 ? 'protected' : 'unprotected')),
    });
    const { container } = render(<CampaignTimeline report={makeReport({ runs: [big] })} />);
    const chart = container.querySelector('svg.rp-svg')!;
    expect(chart.querySelectorAll('.rp-g')).toHaveLength(2);

    // 20 of 30 protected: the bar splits 2:1 and never taller than a full stack.
    const [prot, unprot] = Array.from(chart.querySelectorAll('.rp-g'));
    expect(prot).toHaveClass('rp-g-protected');
    expect(unprot).toHaveClass('rp-g-unprotected');
    expect(num(prot, 'height') / num(unprot, 'height')).toBeCloseTo(2);
    expect(num(prot, 'height') + num(unprot, 'height')).toBeCloseTo(MAX_STACK * 9 - 2);
  });

  it('keeps a run of exactly MAX_STACK stages as a glyph stack, one more becomes a bar', () => {
    const ten = makeRun({ stages: Array.from({ length: MAX_STACK }, (_, i) => stage(i, 'protected')) });
    const eleven = makeRun({ stages: Array.from({ length: MAX_STACK + 1 }, (_, i) => stage(i, 'protected')) });
    const { container: a } = render(<svg><RunColumn run={ten} x={200} top={0} /></svg>);
    const { container: b } = render(<svg><RunColumn run={eleven} x={200} top={0} /></svg>);
    expect(a.querySelectorAll('.rp-g')).toHaveLength(MAX_STACK);
    expect(b.querySelectorAll('.rp-g')).toHaveLength(1);
  });

  describe('keeps everything inside the plot area [X0, X1]', () => {
    // The backend floors axisFrom in UTC, ES buckets in the report tz: a bucket key can
    // precede axisFrom, and the last bucket runs past axisTo.
    const bucket = (start: string) => ({ start, lanes: [{ testKey: BUNDLE, runs: 3, outcomes: counts({ protected: 3, unprotected: 3 }) }] });

    it('clamps a bucket key 4 h before axisFrom to X0, and a last bucket to X1', () => {
      const win = makeWindow({
        axisFrom: '2026-10-11T00:00:00.000Z', axisTo: '2026-10-14T00:00:00.000Z', bucket: 'day',
        firstExecution: '2026-10-11T01:00:00.000Z', lastExecution: '2026-10-13T20:00:00.000Z',
      });
      const report = makeReport({
        meta: { window: win, truncation: { runs: true, tests: false, lanes: false } },
        timeline: {
          lanes: [{ testKey: BUNDLE, name: 'LockBit', runs: 3 }],
          buckets: [bucket('2026-10-10T20:00:00.000Z'), bucket('2026-10-12T20:00:00.000Z'), bucket('2026-10-13T20:00:00.000Z')],
        },
      });
      const { container } = render(<CampaignTimeline report={report} />);
      const bars = Array.from(container.querySelectorAll('svg.rp-svg .rp-g'));
      expect(bars.length).toBeGreaterThan(0);
      for (const r of bars) {
        expect(num(r, 'x')).toBeGreaterThanOrEqual(X0);
        expect(num(r, 'x') + num(r, 'width')).toBeLessThanOrEqual(X1 + 1e-9);
      }
      // The first bucket is drawn at the axis start, not left of it.
      expect(Math.min(...bars.map((r) => num(r, 'x')))).toBeCloseTo(X0);
      for (const l of Array.from(container.querySelectorAll('svg.rp-svg line'))) {
        expect(num(l, 'x1')).toBeGreaterThanOrEqual(X0);
        expect(num(l, 'x2')).toBeLessThanOrEqual(X1);
      }
    });

    it('draws nothing for a bucket that ends before the axis starts', () => {
      const win = makeWindow({
        axisFrom: '2026-10-13T00:00:00.000Z', axisTo: '2026-10-14T00:00:00.000Z', bucket: 'hour',
        firstExecution: '2026-10-13T09:00:00.000Z', lastExecution: '2026-10-13T11:00:00.000Z',
      });
      const report = makeReport({
        meta: { window: win, truncation: { runs: true, tests: false, lanes: false } },
        timeline: {
          lanes: [{ testKey: BUNDLE, name: 'LockBit', runs: 3 }],
          buckets: [bucket('2026-10-12T20:00:00.000Z'), bucket('2026-10-13T10:00:00.000Z')],
        },
      });
      const { container } = render(<CampaignTimeline report={report} />);
      const bars = Array.from(container.querySelectorAll('svg.rp-svg .rp-g'));
      // Only the 10:00 bucket (protected + unprotected segments), far from the left edge.
      expect(bars).toHaveLength(2);
      expect(Math.min(...bars.map((r) => num(r, 'x')))).toBeGreaterThan(X0 + 100);
    });

    it('clamps trend points whose bucket centre precedes axisFrom', () => {
      const win = makeWindow({
        axisFrom: '2026-10-05T00:00:00.000Z', axisTo: '2026-11-02T00:00:00.000Z', bucket: 'week',
        firstExecution: '2026-10-05T00:00:00.000Z', lastExecution: '2026-11-01T00:00:00.000Z',
      });
      const report = makeReport({
        meta: { window: win },
        timeline: {
          lanes: [{ testKey: BUNDLE, name: 'LockBit', runs: 3 }],
          // Week key 5 days before axisFrom: its centre (key + 3.5 d) is still left of the axis.
          buckets: [bucket('2026-09-30T00:00:00.000Z'), bucket('2026-10-12T00:00:00.000Z')],
        },
      });
      const { container } = render(<CampaignTimeline report={report} />);
      const dots = Array.from(container.querySelectorAll('svg.rp-svg .rp-trend-pt'));
      expect(dots).toHaveLength(2);
      expect(num(dots[0], 'cx')).toBe(X0);
      for (const d of dots) expect(num(d, 'cx')).toBeGreaterThanOrEqual(X0);
      const xs = container.querySelector('svg.rp-svg .rp-trend')!.getAttribute('points')!.split(' ').map((p) => Number(p.split(',')[0]));
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(X0);
    });

    it('keeps two runs finishing at the very end of the axis inside X1 and still apart', () => {
      const one = (completedAt: string, hostname: string) =>
        makeRun({ completedAt, hostname, stages: [stage(0, 'protected')] });
      const end = makeWindow().axisTo;
      const report = makeReport({
        runs: [one(end, 'WS-A'), one(new Date(Date.parse(end) - 60_000).toISOString(), 'WS-B')],
      });
      const { container } = render(<CampaignTimeline report={report} />);
      const centres = Array.from(container.querySelectorAll('svg.rp-svg .rp-g')).map((r) => num(r, 'x') + num(r, 'width') / 2);
      expect(centres).toHaveLength(2);
      expect(Math.max(...centres)).toBeLessThanOrEqual(X1);
      expect(Math.abs(centres[0] - centres[1])).toBeGreaterThanOrEqual(10 - 1e-9);
    });
  });

  it('draws the "Other tests" lane and the runs of tests outside the top lanes in it', () => {
    const other: ReportRun = makeRun({ testKey: 'f3a1c9d0-0000-4000-8000-000000000001', stages: [stage(0, 'protected')] });
    const report = makeReport({
      runs: [makeRun(), other],
      timeline: {
        lanes: [
          { testKey: BUNDLE, name: 'LockBit 3.0 Double Extortion Kill Chain', runs: 1 },
          { testKey: '__other__', name: 'Other tests (9)', runs: 4 },
        ],
        buckets: [],
      },
    });
    const { container } = render(<CampaignTimeline report={report} />);
    expect(screen.getByText('Other tests (9)')).toBeInTheDocument();
    expect(screen.getByText('4 runs')).toBeInTheDocument();
    const marks = Array.from(container.querySelectorAll('svg.rp-svg .rp-g'));
    expect(marks).toHaveLength(6);
    // Marks are drawn lane by lane: the last one is the lone "other" glyph, below all of lane one.
    const yOf = (m: Element) => (m.tagName === 'circle' ? num(m, 'cy') : num(m, 'y'));
    const ys = marks.map(yOf);
    expect(ys[5]).toBeGreaterThan(Math.max(...ys.slice(0, 5)));
  });

  it('computes axis ticks once for an unchanged window, not on every render', () => {
    vi.mocked(axisTicks).mockClear();
    const { rerender } = render(<CampaignTimeline report={makeReport()} />);
    rerender(<CampaignTimeline report={makeReport()} />);
    expect(axisTicks).toHaveBeenCalledTimes(1);
    rerender(<CampaignTimeline report={makeReport({ meta: { tz: 'America/Santo_Domingo' } })} />);
    expect(axisTicks).toHaveBeenCalledTimes(2);
  });

  it('puts stroke="none" on every SVG text element', () => {
    const { container } = render(<CampaignTimeline report={makeReport()} />);
    const texts = Array.from(container.querySelectorAll('svg.rp-svg text'));
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) expect(t).toHaveAttribute('stroke', 'none');
  });
});
