import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Cover } from '../Cover';
import { ExecutiveSummary } from '../ExecutiveSummary';
import { ActorsAndCoverage } from '../ActorsAndCoverage';
import { Sheet } from '../Sheet';
import { windowText } from '../scope';
import { GLYPH } from '../../diagrams/CampaignTimeline';
import { counts, makeReport, makeRun, makeWindow } from '../../__tests__/fixtures';
import { ALL_TIME_FROM } from '@/hooks/useAnalyticsFilters';
import type { OutcomeCounts, ReportHost } from '@/services/api/reports';

const head = { left: 'h', right: 'r' };
const PARTIAL = { failedShards: 2, totalShards: 5 };
const PARTIAL_TEXT = 'Some data in scope could not be read (2 of 5 shards); totals may be incomplete.';
const ALERTS_INCOMPLETE = 'EDR alert correlation was incomplete — see the notice on the summary page.';

const host = (hostname: string, c: Partial<OutcomeCounts>): ReportHost => ({ hostname, runs: 1, outcomes: counts(c) });
/** The hostnames in the by-endpoint chart, top to bottom. */
const chartHosts = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.rp-bar-row')).map((row) => row.firstElementChild?.textContent);
/** The value cell next to a label in a key/value list. */
const valueOf = (label: string) => screen.getByText(label).nextElementSibling as HTMLElement;
const RUN_STRIP_NAME = 'Every run in the report, oldest first';
/** n runs with distinct keys, on distinct hosts. */
const manyRuns = (n: number) => Array.from({ length: n }, (_, i) => makeRun({
  hostname: `WS-${String(i).padStart(3, '0')}`,
  completedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + i * 3_600_000).toISOString(),
  taskId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
}));

describe('Sheet', () => {
  it('is a named region whose running head is hidden from assistive tech', () => {
    render(<Sheet label="Demo" head={head}><p>body</p></Sheet>);
    expect(screen.getByRole('region', { name: 'Demo' })).toHaveTextContent('body');
    expect(screen.getByText('h').closest('header')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('Cover', () => {
  it('names the scope, the window and the marking', () => {
    render(<Cover report={makeReport()} marking="TLP:AMBER" />);
    expect(screen.getByRole('heading', { name: 'Security Validation Report' })).toBeInTheDocument();
    expect(screen.getAllByText('All organizations').length).toBeGreaterThan(0);
    expect(screen.getByText('TLP:AMBER')).toBeInTheDocument();
    expect(screen.getByText('RPT-20261013-7F3A')).toBeInTheDocument();
  });

  it('warns on the cover when the report is filtered by outcome', () => {
    render(<Cover report={makeReport({ meta: { outcomeFiltered: ['result=unprotected'], filters: { result: 'unprotected' } } })} marking="None" />);
    expect(screen.getByRole('note')).toHaveTextContent('Filtered by outcome: Result is unprotected.');
    expect(screen.getByText('Not marked')).toBeInTheDocument();
  });

  it('prints first-execution dates instead of the year 2000 for All time', () => {
    const report = makeReport({ meta: { window: makeWindow({ preset: 'all', label: 'All time', effectiveFrom: ALL_TIME_FROM }) } });
    expect(windowText(report)).toBe('11 Oct 2026 – 13 Oct 2026');
  });

  it('banners a partial read so the totals are not taken as complete', () => {
    render(<Cover report={makeReport({ meta: { partial: PARTIAL } })} marking="None" />);
    expect(screen.getByRole('note')).toHaveTextContent(PARTIAL_TEXT);
  });

  it('shows no data banner when every shard was read', () => {
    render(<Cover report={makeReport()} marking="None" />);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('renders first-execution dates, not the year 2000, for an All-time cover', () => {
    const report = makeReport({ meta: { window: makeWindow({ preset: 'all', label: 'All time', effectiveFrom: ALL_TIME_FROM }) } });
    const { container } = render(<Cover report={report} marking="None" />);
    expect(container.textContent).not.toContain('2000');
    expect(screen.getByText('All time · 11 Oct 2026 – 13 Oct 2026')).toBeInTheDocument();
    expect(valueOf('Window')).toHaveTextContent('All time: 11 Oct 2026, 09:12 – 13 Oct 2026, 23:40 UTC');
  });

  it('shows a custom range in the report time zone, not UTC', () => {
    const report = makeReport({
      meta: {
        tz: 'America/Santo_Domingo',
        window: makeWindow({
          preset: 'custom', label: 'Custom range',
          effectiveFrom: '2026-10-01T03:00:00.000Z', effectiveTo: '2026-10-10T20:30:00.000Z',
          firstExecution: '2026-10-02T01:30:00.000Z', lastExecution: '2026-10-09T15:00:00.000Z',
        }),
      },
    });
    render(<Cover report={report} marking="None" />);
    // 03:00Z on 1 Oct is 23:00 on 30 Sep at UTC-4, so the date moves back a day.
    expect(screen.getByText('Custom range · 30 Sep 2026 – 10 Oct 2026')).toBeInTheDocument();
    expect(valueOf('Window')).toHaveTextContent('Custom range: 30 Sep 2026, 23:00 – 10 Oct 2026, 16:30 AST');
    expect(valueOf('Executions')).toHaveTextContent('1 Oct 2026, 21:30 – 9 Oct 2026, 11:00');
    expect(valueOf('Generated')).toHaveTextContent('13 Oct 2026, 19:40 AST');
  });

  it('lists every value of a multi-value filter and leaves out the org filter', () => {
    render(<Cover report={makeReport({ meta: { filters: { org: 'org_1', hostnames: 'WS-A,WS-B', tests: 'Mimikatz' } } })} marking="None" />);
    expect(valueOf('Filters')).toHaveTextContent('Endpoints: WS-A, WS-B · Tests: Mimikatz');
    expect(valueOf('Filters')).not.toHaveTextContent('org_1');
  });

  it('reads None when no filter is applied', () => {
    render(<Cover report={makeReport()} marking="None" />);
    expect(valueOf('Filters')).toHaveTextContent('None');
  });

  it('says so when no execution fell in the window', () => {
    render(<Cover report={makeReport({ meta: { window: makeWindow({ firstExecution: null, lastExecution: null }) } })} marking="None" />);
    expect(valueOf('Executions')).toHaveTextContent('None in this window');
  });

  describe('run strip', () => {
    // 680 / (GLYPH + 1) columns fit with a 1-unit gap between the 7-unit glyphs.
    const CAP = Math.floor(680 / (GLYPH + 1));

    it('draws the strip for a scope exactly at the cap, with no glyph overlapping the next', () => {
      render(<Cover report={makeReport({ runs: manyRuns(CAP) })} marking="None" />);
      // Query inside the strip: the legend below it draws glyph icons of its own.
      const strip = screen.getByRole('img', { name: RUN_STRIP_NAME });
      const xs = [...new Set(Array.from(strip.querySelectorAll('rect.rp-g')).map((r) => Number(r.getAttribute('x'))))].sort((a, b) => a - b);
      expect(xs).toHaveLength(CAP);
      const gaps = xs.slice(1).map((x, i) => x - xs[i]);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(GLYPH + 1 - 1e-6);
    });

    it('drops the strip for a scope above the cap', () => {
      render(<Cover report={makeReport({ runs: manyRuns(CAP + 1) })} marking="None" />);
      expect(screen.queryByRole('img', { name: RUN_STRIP_NAME })).not.toBeInTheDocument();
    });

    it('drops the strip when the run list was truncated', () => {
      render(<Cover report={makeReport({ meta: { truncation: { runs: true, tests: false, lanes: false } } })} marking="None" />);
      expect(screen.queryByRole('img', { name: RUN_STRIP_NAME })).not.toBeInTheDocument();
    });
  });
});

describe('ExecutiveSummary', () => {
  it('shows the verdict, the Defense Score and the median first alert', () => {
    render(<ExecutiveSummary report={makeReport()} head={head} />);
    expect(screen.getByText(/6 of 9 conclusive stage results/)).toBeInTheDocument();
    // One decimal, like the dashboard and the verdict sentence.
    expect(screen.getByText('61.5%')).toBeInTheDocument();
    expect(screen.getByText('−3m 18s')).toBeInTheDocument();
  });

  it('lists section warnings so a missing section is never silent (Review Focus #4)', () => {
    render(<ExecutiveSummary report={makeReport({ meta: { warnings: ['EDR alerts unavailable: index_not_found'] } })} head={head} />);
    expect(screen.getByText('Some sections are incomplete.')).toBeInTheDocument();
    expect(screen.getByText('EDR alerts unavailable: index_not_found')).toBeInTheDocument();
  });

  it('lists every warning, including repeated text', () => {
    render(<ExecutiveSummary report={makeReport({ meta: { warnings: ['Run start times unavailable', 'Accepted risks unavailable', 'Accepted risks unavailable'] } })} head={head} />);
    expect(screen.getAllByText('Accepted risks unavailable')).toHaveLength(2);
    expect(screen.getByText('Run start times unavailable')).toBeInTheDocument();
  });

  it('shows no incomplete-sections notice when nothing degraded', () => {
    render(<ExecutiveSummary report={makeReport()} head={head} />);
    expect(screen.queryByText('Some sections are incomplete.')).not.toBeInTheDocument();
  });

  it('says unavailable, not a dash, when the Defense Score lookup failed', () => {
    render(<ExecutiveSummary report={makeReport({ meta: { unavailable: ['defenseScore'] } })} head={head} />);
    expect(screen.getByText('unavailable')).toBeInTheDocument();
    expect(screen.queryByText('61.5%')).not.toBeInTheDocument();
  });

  it('shows the score before accepted risks to one decimal', () => {
    const report = makeReport({ defenseScore: { score: 61.5, rawScore: 70.4, riskAcceptedCount: 3 } });
    render(<ExecutiveSummary report={report} head={head} />);
    expect(screen.getByText(/70\.4% before accepted risks/)).toBeInTheDocument();
  });

  it('banners a partial read below the section heading', () => {
    render(<ExecutiveSummary report={makeReport({ meta: { partial: PARTIAL } })} head={head} />);
    expect(screen.getByText(PARTIAL_TEXT)).toBeInTheDocument();
  });

  it('omits all EDR content when no EDR vendor is configured', () => {
    const { container } = render(<ExecutiveSummary report={makeReport({ meta: { edrVendors: [] } })} head={head} />);
    expect(screen.queryByText(/Median first EDR alert/)).not.toBeInTheDocument();
    expect(screen.queryByText('−3m 18s')).not.toBeInTheDocument();
    expect(screen.queryByText(ALERTS_INCOMPLETE)).not.toBeInTheDocument();
    expect(container.querySelectorAll('.rp-kpi')).toHaveLength(5);
  });

  it('omits the alert-incomplete note when no EDR vendor is configured, even if alerts were flagged', () => {
    render(<ExecutiveSummary report={makeReport({ meta: { edrVendors: [], unavailable: ['alerts'] } })} head={head} />);
    expect(screen.queryByText(ALERTS_INCOMPLETE)).not.toBeInTheDocument();
  });

  it('flags incomplete alert correlation but still reports the alerts that were found', () => {
    render(<ExecutiveSummary report={makeReport({ meta: { unavailable: ['alerts'] } })} head={head} />);
    expect(screen.getByText(ALERTS_INCOMPLETE)).toBeInTheDocument();
    expect(screen.getByText('−3m 18s')).toBeInTheDocument();
  });

  it('keeps all six tiles when EDR is configured', () => {
    const { container } = render(<ExecutiveSummary report={makeReport()} head={head} />);
    expect(container.querySelectorAll('.rp-kpi')).toHaveLength(6);
    expect(screen.queryByText(ALERTS_INCOMPLETE)).not.toBeInTheDocument();
  });
});

describe('ExecutiveSummary page breaks', () => {
  it('keeps the Campaign timeline heading in the same unbreakable block as its chart', () => {
    render(<ExecutiveSummary report={makeReport()} head={head} />);
    const heading = screen.getByRole('heading', { name: 'Campaign timeline' });
    const chart = screen.getByRole('img', { name: /^Campaign timeline/ });
    const block = heading.closest('.rp-avoid');
    expect(block).not.toBeNull();
    expect(chart.closest('.rp-avoid')).toBe(block);
  });
});

describe('ExecutiveSummary endpoint chart', () => {
  it('lists the weakest endpoint first', () => {
    const { container } = render(<ExecutiveSummary report={makeReport()} head={head} />);
    // WS-FIN-014 is 3 of 5 (60%), WS-OPS-022 is 3 of 4 (75%).
    expect(chartHosts(container)).toEqual(['WS-FIN-014', 'WS-OPS-022']);
  });

  it('breaks rate ties by the larger sample and puts hosts with no verdict last', () => {
    const report = makeReport({
      hosts: [host('NO-VERDICT', { skipped: 3 }), host('SMALL', { protected: 1, unprotected: 1 }), host('LARGE', { protected: 5, unprotected: 5 })],
    });
    const { container } = render(<ExecutiveSummary report={report} head={head} />);
    expect(chartHosts(container)).toEqual(['LARGE', 'SMALL', 'NO-VERDICT']);
  });

  it('keeps the 12 weakest of a longer list', () => {
    const hosts = Array.from({ length: 14 }, (_, i) => host(`H${String(i + 1).padStart(2, '0')}`, { protected: i + 1, unprotected: 15 - (i + 1) }));
    const base = makeReport();
    const { container } = render(<ExecutiveSummary report={makeReport({ hosts: [...hosts].reverse(), totals: { ...base.totals, endpoints: 14 } })} head={head} />);
    expect(chartHosts(container)).toEqual(hosts.slice(0, 12).map((h) => h.hostname));
    expect(screen.getByRole('heading', { name: 'Lowest 12 of 14 endpoints by stage protection rate' })).toBeInTheDocument();
  });

  it('counts the heading from the endpoint total, not from the capped host list', () => {
    const hosts = Array.from({ length: 100 }, (_, i) => host(`H${i}`, { protected: 1, unprotected: 1 }));
    const base = makeReport();
    render(<ExecutiveSummary report={makeReport({ hosts, totals: { ...base.totals, endpoints: 1500 } })} head={head} />);
    expect(screen.getByRole('heading', {
      name: 'Lowest 12 of 1,500 endpoints by stage protection rate (among the 100 busiest)',
    })).toBeInTheDocument();
  });

  it('does not claim a narrower pool when every endpoint is in the list', () => {
    render(<ExecutiveSummary report={makeReport()} head={head} />);
    expect(screen.getByRole('heading', { name: 'Lowest 2 of 2 endpoints by stage protection rate' })).toBeInTheDocument();
    expect(screen.queryByText(/busiest/)).not.toBeInTheDocument();
  });
});

describe('ActorsAndCoverage', () => {
  it('groups techniques by tactic and lists other tests', () => {
    const report = makeReport({ otherTests: [{ testKey: 'x', name: 'Mimikatz', runs: 3, outcomes: counts({ protected: 3 }) }] });
    render(<ActorsAndCoverage report={report} head={head} />);
    expect(screen.getByText('LockBit 3.0 (S1202)')).toBeInTheDocument();
    expect(screen.getByText('Credential Access')).toBeInTheDocument();
    expect(screen.getByText('T1567.002')).toBeInTheDocument();
    expect(screen.getByText('Mimikatz')).toBeInTheDocument();
  });

  it('files techniques with no tactic under Other and says so when no actor is attributed', () => {
    const base = makeReport();
    const report = makeReport({ actors: [], techniques: [{ ...base.techniques[0], tactic: null }] });
    render(<ActorsAndCoverage report={report} head={head} />);
    expect(screen.getByText('Other')).toBeInTheDocument();
    expect(screen.getByText('No threat actor is attributed to the tests in this scope.')).toBeInTheDocument();
  });

  it('labels each percentage a stage protection rate', () => {
    const report = makeReport({ otherTests: [{ testKey: 'x', name: 'Mimikatz', runs: 3, outcomes: counts({ protected: 3 }) }] });
    render(<ActorsAndCoverage report={report} head={head} />);
    expect(screen.getByText('Stage protection rate', { selector: 'dt' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Stage protection rate' })).toBeInTheDocument();
    expect(screen.queryByText('Protection')).not.toBeInTheDocument();
  });
});
