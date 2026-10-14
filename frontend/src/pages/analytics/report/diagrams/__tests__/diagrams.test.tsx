import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReportAlert, ReportRun, ReportRunStage } from '@/services/api/reports';
import { KillChainFlow } from '../KillChainFlow';
import { LatencyDotPlot, firstAlertMinutes, median } from '../LatencyDotPlot';
import { RunStrip, stageLabelFor } from '../RunStrip';
import { makeRun, makeTest } from '../../__tests__/fixtures';

/** Mirrors the run strip's plot area: X0 = 6, X1 = 680 - 40. */
const STRIP_X0 = 6;
const STRIP_X1 = 640;

const COMPLETED = Date.parse('2026-10-12T12:47:49.000Z');
const minutesFromCompletion = (m: number) => new Date(COMPLETED + m * 60_000).toISOString();

const alertAt = (m: number, over: Partial<ReportAlert> = {}): ReportAlert => ({
  vendor: 'defender', title: 'Alert', severity: 'high', status: 'new', createdAt: minutesFromCompletion(m),
  stageControlId: null, preventionAction: null, portalUrl: null, autoResolvedAt: null, ...over,
});

const stage = (order: number, outcome: ReportRunStage['outcome']): ReportRunStage => ({
  controlId: `T${1000 + order}`, name: `Stage ${order}`, order, outcome, exitCode: null, techniques: [], tactics: [], highImpact: false,
});

const num = (el: Element, attr: string) => Number(el.getAttribute(attr));
const labels = (container: HTMLElement) => Array.from(container.querySelectorAll('text.rp-sub'));
const firstNumber = (path: Element) => Number(/^M(-?[\d.]+)/.exec(path.getAttribute('d') ?? '')?.[1]);

describe('KillChainFlow', () => {
  it('draws one chevron per stage with its band and stage name', () => {
    const { container } = render(<KillChainFlow test={makeTest()} />);
    expect(container.querySelectorAll('polygon.rp-kc')).toHaveLength(5);
    expect(screen.getByText('S1')).toBeInTheDocument();
    expect(screen.getByText('Pre-encryption exfiltration')).toBeInTheDocument();
    expect(screen.getAllByText('Gap').length).toBeGreaterThan(0);
  });

  it('wraps chains longer than six stages onto a second row', () => {
    const test = makeTest();
    const eight = makeTest({ stages: [...test.stages, ...test.stages.slice(0, 3)].map((s, i) => ({ ...s, order: i + 1 })) });
    const { container } = render(<KillChainFlow test={eight} />);
    expect(container.querySelectorAll('svg.rp-svg')).toHaveLength(2);
  });

  it('keeps every chevron the same width when the last row is short', () => {
    const base = makeTest().stages;
    const seven = makeTest({ stages: [...base, ...base.slice(0, 2)].map((s, i) => ({ ...s, order: i + 1 })) });
    const { container } = render(<KillChainFlow test={seven} />);
    const [row1, row2] = Array.from(container.querySelectorAll('svg.rp-svg'));
    const rightEdge = (p: Element) => Math.max(...(p.getAttribute('points') ?? '').split(' ').map((pt) => Number(pt.split(',')[0])));
    // Row 2 holds the lone 7th stage in the first column, not one chevron stretched across the page.
    expect(row2.querySelectorAll('polygon.rp-kc')).toHaveLength(1);
    expect(rightEdge(row1.querySelector('polygon.rp-kc')!)).toBeCloseTo(680 / 6);
    expect(rightEdge(row2.querySelector('polygon.rp-kc')!)).toBeCloseTo(680 / 6);
  });

  it('keeps stroke="none" on every SVG text', () => {
    const { container } = render(<KillChainFlow test={makeTest()} />);
    const texts = Array.from(container.querySelectorAll('svg text'));
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) expect(t).toHaveAttribute('stroke', 'none');
  });
});

describe('LatencyDotPlot', () => {
  it('measures first alerts from run completion, per vendor and overall', () => {
    const runs = [makeRun()];
    expect(firstAlertMinutes(runs, 'defender')[0]).toBeCloseTo(-3.3, 1);
    expect(firstAlertMinutes(runs, 'crowdstrike')[0]).toBeCloseTo(1.03, 1);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
  });

  it('only counts runs that raised an alert', () => {
    expect(firstAlertMinutes([makeRun({ alerts: [] })])).toEqual([]);
    expect(firstAlertMinutes([makeRun(), makeRun({ alerts: [] })])).toHaveLength(1);
  });

  it('plots one dot per run and labels the median', () => {
    const { container } = render(<LatencyDotPlot runs={[makeRun(), makeRun({ alerts: [] })]} />);
    expect(container.querySelectorAll('circle')).toHaveLength(3);
    // The Defender row and the "any EDR" row share the run's first alert.
    expect(screen.getAllByText('1 run · median −3m 18s')).toHaveLength(2);
    expect(screen.getByText('1 run · median +1m 02s')).toBeInTheDocument();
  });

  it('renders nothing when no run raised an alert', () => {
    const { container } = render(<LatencyDotPlot runs={[makeRun({ alerts: [] })]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps stroke="none" on every SVG text', () => {
    const { container } = render(<LatencyDotPlot runs={[makeRun()]} />);
    const texts = Array.from(container.querySelectorAll('svg text'));
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) expect(t).toHaveAttribute('stroke', 'none');
  });
});

describe('RunStrip', () => {
  it('labels alerts during the run and after it, with their stage', () => {
    render(<RunStrip run={makeRun()} />);
    expect(screen.getByText('Defender during run · Privileged credential access')).toBeInTheDocument();
    expect(screen.getByText('Falcon +1m 02s · Encryption & recovery inhibition')).toBeInTheDocument();
  });

  it('draws the run bar with one glyph per stage when the start time is known', () => {
    const { container } = render(<RunStrip run={makeRun()} />);
    expect(screen.getByRole('img', { name: 'Run timeline in minutes from start' })).toBeInTheDocument();
    expect(container.querySelectorAll('.rp-run-bar')).toHaveLength(1);
    expect(container.querySelectorAll('.rp-g')).toHaveLength(5);
    expect(container.querySelector('.rp-marker')).toBeNull();
  });

  it('draws no glyph for a skipped stage: skipped stages are not results', () => {
    const run = makeRun({ stages: [stage(1, 'protected'), stage(2, 'skipped'), stage(3, 'unprotected')] });
    const { container } = render(<RunStrip run={run} />);
    expect(container.querySelectorAll('.rp-g')).toHaveLength(2);
    expect(container.querySelector('.rp-g-skipped')).toBeNull();
  });

  it('draws only a completion marker when the start time is unknown (Review Focus #2)', () => {
    const { container } = render(<RunStrip run={makeRun({ startedAt: null })} />);
    expect(screen.getByRole('img', { name: 'Alerts in minutes from run completion' })).toBeInTheDocument();
    expect(screen.getByText('completed (start time unavailable)')).toBeInTheDocument();

    // No run bar and no stage glyphs: only the completion marker, five minutes into the axis.
    expect(container.querySelector('.rp-run-bar')).toBeNull();
    expect(container.querySelectorAll('.rp-g')).toHaveLength(0);
    const marker = container.querySelector('.rp-marker')!;
    expect(num(marker, 'x1')).toBeCloseTo(STRIP_X0 + (5 / 25) * (STRIP_X1 - STRIP_X0), 5);

    // The axis runs from -5 min (the correlation lead) to +20 min after completion.
    const ticks = Array.from(container.querySelectorAll('text.rp-tick')).map((t) => t.textContent);
    expect(ticks).toEqual(['−5', '0', '+5', '+10', '+15', '+20 min']);
  });

  it('says so when no EDR alerted', () => {
    render(<RunStrip run={makeRun({ alerts: [] })} />);
    expect(screen.getByText('no EDR alert within 30 min')).toBeInTheDocument();
  });

  it('says "alerts not checked", not "none", when the correlation search did not complete', () => {
    render(<RunStrip run={makeRun({ alerts: [], alertsChecked: false })} />);
    expect(screen.getByText('alerts not checked')).toBeInTheDocument();
    expect(screen.queryByText('no EDR alert within 30 min')).toBeNull();
  });

  it('still draws the alerts that were found when the run is not fully checked', () => {
    render(<RunStrip run={makeRun({ alertsChecked: false })} />);
    expect(screen.getByText('Falcon +1m 02s · Encryption & recovery inhibition')).toBeInTheDocument();
    expect(screen.queryByText('alerts not checked')).toBeNull();
    expect(screen.queryByText('no EDR alert within 30 min')).toBeNull();
  });

  it('keeps an alert that precedes a short run inside the axis', () => {
    // A 2-minute run, alert raised 4 minutes before it completed (2 minutes before it started).
    const run = makeRun({
      startedAt: minutesFromCompletion(-2),
      alerts: [alertAt(-4, { stageControlId: null })],
    });
    const { container } = render(<RunStrip run={run} />);
    const diamond = container.querySelector('.rp-al-defender')!;
    expect(firstNumber(diamond)).toBeGreaterThanOrEqual(STRIP_X0);
    const ticks = Array.from(container.querySelectorAll('text.rp-tick')).map((t) => t.textContent);
    expect(ticks[0]).toBe('−5');
    expect(ticks).toContain('0');
  });

  it('stacks alert labels that would overlap onto separate rows', () => {
    const run = makeRun({ alerts: [alertAt(1), alertAt(1.1), alertAt(1.2)] });
    const { container } = render(<RunStrip run={run} />);
    const ys = labels(container).filter((t) => t.textContent?.startsWith('Defender')).map((t) => num(t, 'y'));
    expect(new Set(ys).size).toBe(3);
  });

  it('grows the strip instead of drawing labels above it when many alerts stack', () => {
    const run = makeRun({ alerts: Array.from({ length: 6 }, (_, i) => alertAt(1 + i * 0.05)) });
    const { container } = render(<RunStrip run={run} />);
    const ys = labels(container).filter((t) => t.textContent?.startsWith('Defender')).map((t) => num(t, 'y'));
    expect(new Set(ys).size).toBe(6);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(8);
    const base = render(<RunStrip run={makeRun()} />).container.querySelector('svg')!;
    const grown = container.querySelector('svg')!;
    expect(Number(grown.getAttribute('viewBox')!.split(' ')[3])).toBeGreaterThan(Number(base.getAttribute('viewBox')!.split(' ')[3]));
  });

  it('flips a label that would run off the right edge to end at its marker', () => {
    const run = makeRun({ alerts: [alertAt(28, { stageControlId: 't1486' })] });
    const { container } = render(<RunStrip run={run} />);
    const label = labels(container).find((t) => t.textContent?.startsWith('Defender'))!;
    expect(label).toHaveAttribute('text-anchor', 'end');
    expect(num(label, 'x')).toBeLessThanOrEqual(STRIP_X1);
  });

  it('truncates a very long stage name in the label', () => {
    const long = 'Ensure the account lockout threshold is configured to five or fewer invalid attempts';
    const run = makeRun({
      stages: [{ ...stage(1, 'unprotected'), controlId: 'CH-1', name: long }],
      alerts: [alertAt(1, { stageControlId: 'ch-1' })],
    });
    render(<RunStrip run={run} />);
    expect(screen.getByText('Defender +1m 00s · Ensure the account lockout threshold is…')).toBeInTheDocument();
  });

  it('keeps stroke="none" on every SVG text', () => {
    const { container } = render(<RunStrip run={makeRun()} />);
    const texts = Array.from(container.querySelectorAll('svg text'));
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) expect(t).toHaveAttribute('stroke', 'none');
  });
});

describe('stageLabelFor', () => {
  it('resolves stage tokens to the stage name, including variant suffixes', () => {
    const run = makeRun();
    expect(stageLabelFor(run, 't1486')).toBe('Encryption & recovery inhibition');
    expect(stageLabelFor(run, 't1486-variant')).toBe('Encryption & recovery inhibition');
    expect(stageLabelFor(run, null)).toBe('bundle');
  });

  it('matches a lowercased backend token against an uppercase controlId', () => {
    const run = makeRun();
    // The backend lowercases ReportAlert.stageControlId; ReportRunStage.controlId keeps its case.
    expect(run.stages[1].controlId).toBe('T1003.001');
    expect(stageLabelFor(run, 't1003.001')).toBe('Privileged credential access');
    expect(stageLabelFor(run, 'T1003.001')).toBe('Privileged credential access');
    expect(stageLabelFor(run, 't1003.001-variant')).toBe('Privileged credential access');
  });

  it('falls back to the controlId when the stage has no name (big-scope reports omit it)', () => {
    const run = makeRun({ stages: makeRun().stages.map(({ name: _name, ...s }) => s) });
    expect(stageLabelFor(run, 't1003.001')).toBe('T1003.001');
  });

  it('says "bundle" when the token names no stage of the run', () => {
    expect(stageLabelFor(makeRun(), 't9999')).toBe('bundle');
    // A prefix is not a match unless it ends at a hyphen.
    expect(stageLabelFor(makeRun(), 't14860')).toBe('bundle');
  });

  it('never matches a stage without a controlId', () => {
    const run: ReportRun = makeRun({ stages: [{ ...stage(1, 'protected'), controlId: null }] });
    expect(stageLabelFor(run, 't1001')).toBe('bundle');
  });
});
