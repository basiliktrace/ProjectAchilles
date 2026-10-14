import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Cover } from '../Cover';
import { ExecutiveSummary } from '../ExecutiveSummary';
import { ActorsAndCoverage } from '../ActorsAndCoverage';
import { Sheet } from '../Sheet';
import { windowText } from '../scope';
import { counts, makeReport, makeWindow } from '../../__tests__/fixtures';
import { ALL_TIME_FROM } from '@/hooks/useAnalyticsFilters';

const head = { left: 'h', right: 'r' };
const PARTIAL = { failedShards: 2, totalShards: 5 };
const PARTIAL_TEXT = 'Some data in scope could not be read (2 of 5 shards); totals may be incomplete.';
const ALERTS_INCOMPLETE = 'EDR alert correlation was incomplete — see the notice on the summary page.';

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
});
