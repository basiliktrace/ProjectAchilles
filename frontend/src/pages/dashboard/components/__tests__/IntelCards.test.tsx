import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { ActorReadinessView, AttackMatrixView, CadenceView } from '../../dashboardViews';
import { TestingCadenceCard } from '../TestingCadenceCard';
import { ThreatActorReadinessCard } from '../ThreatActorReadinessCard';
import { AttackOutcomeMatrix } from '../AttackOutcomeMatrix';

const wrap = (ui: ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

const cadence: CadenceView = {
  bars: [
    { date: '2026-10-19', protected: 5, unprotected: 2, inconclusive: 1 },
    { date: '2026-10-20', protected: 0, unprotected: 0, inconclusive: 0 },
  ],
  noRuns: false,
  lastRunDaysAgo: 3,
  lastRunAt: '2026-10-17T10:00:00Z',
  executions7d: 142,
  protectedPct7d: 90,
  endpointsTested7d: 8,
  agentsTotal: 36,
  tasks24h: { completed: 131, failed: 6, inProgress: 5 },
  nextScheduled: { when: '2026-10-27T09:00:00Z', label: 'APT34 chain', endpoints: 12 },
};

describe('TestingCadenceCard', () => {
  it('renders the cadence view', () => {
    wrap(<TestingCadenceCard view={cadence} />);
    expect(screen.getByText('Testing cadence')).toBeInTheDocument();
    expect(screen.getByText('last run 3d ago')).toBeInTheDocument();
    expect(screen.getByText('142 in 7d')).toBeInTheDocument();
    expect(screen.getByText(/131 done/)).toBeInTheDocument();
    expect(screen.getByText(/APT34 chain on 12 endpoints/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Daily executions/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Tasks/ })).toHaveAttribute('href', '/tasks');
  });
  it('shows "no runs yet" and never NaN', () => {
    const { container } = wrap(
      <TestingCadenceCard
        view={{ ...cadence, bars: [], noRuns: true, lastRunDaysAgo: null, lastRunAt: null,
          executions7d: 0, protectedPct7d: null, tasks24h: null, nextScheduled: null }}
      />,
    );
    expect(screen.getByText('no runs yet')).toBeInTheDocument();
    expect(container.textContent).not.toContain('NaN');
  });
  it('shows a skeleton when loading', () => {
    const { container } = wrap(<TestingCadenceCard view={null} loading />);
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
  });
});

const actors: ActorReadinessView = {
  rows: [
    { threatActor: 'APT34', score: 64, pairCount: 14, testCount: 7, exposed: true, lastTestedAt: '2026-10-18T00:00:00Z', daysAgo: 2, stale: false },
    { threatActor: 'BlueNoroff', score: 100, pairCount: 3, testCount: 1, exposed: false, lastTestedAt: null, daysAgo: null, stale: false },
  ],
  totalActors: 2,
  exposedCount: 1,
  untestedActors: ['Agrius', 'AMOS'],
  rangeLabel: 'the last 30d',
  empty: false,
};

describe('ThreatActorReadinessCard', () => {
  it('renders rows, exposed chip and untested actors', () => {
    wrap(<ThreatActorReadinessCard view={actors} />);
    expect(screen.getByText('APT34')).toBeInTheDocument();
    expect(screen.getByText('1 exposed')).toBeInTheDocument();
    expect(screen.getByText(/Agrius, AMOS/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Run/ })).toHaveAttribute('href', '/tests');
  });
  it('renders the empty state', () => {
    wrap(<ThreatActorReadinessCard view={{ ...actors, rows: [], totalActors: 0, exposedCount: 0, untestedActors: [], empty: true }} />);
    expect(screen.getByText('No threat-actor tests in the library')).toBeInTheDocument();
  });
  it('shows a skeleton when loading', () => {
    const { container } = wrap(<ThreatActorReadinessCard view={null} loading />);
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
  });
});

const cell = (technique: string, state: 'stopped' | 'partial' | 'through' | 'notRun', label: string) =>
  ({ technique, state, protected: 0, detected: 0, unprotected: 0, label });
const matrix: AttackMatrixView = {
  columns: [
    { slug: 'initial-access', code: 'IA', name: 'Initial Access', throughCount: 1, stoppedCount: 1, testedCount: 2,
      cells: [
        cell('T1566', 'through', 'T1566 · 7 blocked · 2 detected only · 4 got through of 13 endpoints'),
        cell('T1190', 'stopped', 'T1190 · 5 blocked of 5 endpoints'),
      ] },
    { slug: 'execution', code: 'EX', name: 'Execution', throughCount: 0, stoppedCount: 0, testedCount: 0,
      cells: [cell('T1059.001', 'notRun', 'T1059.001 · in library, not run in this range')] },
  ],
  totals: { through: 1, partial: 0, stopped: 1, notRun: 1, techniques: 3 },
  weakestTactic: { slug: 'initial-access', code: 'IA', name: 'Initial Access', throughCount: 1 },
  empty: false,
};

describe('AttackOutcomeMatrix', () => {
  it('renders cells as links with state labels', () => {
    wrap(<AttackOutcomeMatrix view={matrix} />);
    const cell = screen.getByRole('link', { name: 'T1566 · 7 blocked · 2 detected only · 4 got through of 13 endpoints' });
    expect(cell).toHaveAttribute('href', '/analytics?techniques=T1566');
    expect(screen.getByRole('link', { name: 'T1059.001 · in library, not run in this range' })).toBeInTheDocument();
    expect(screen.getByText('1 got through')).toBeInTheDocument();
    expect(screen.getByText('1 stopped')).toBeInTheDocument();
    expect(screen.getByText('stopped (≥95%)')).toBeInTheDocument();
    expect(screen.getByText('Initial Access (1 got through)')).toBeInTheDocument();
    expect(screen.getByText('1/2')).toBeInTheDocument();
  });
  it('renders the empty state', () => {
    wrap(<AttackOutcomeMatrix view={{ ...matrix, columns: [], weakestTactic: null, empty: true }} />);
    expect(screen.getByText('No ATT&CK-mapped tests yet')).toBeInTheDocument();
  });
  it('shows a skeleton when loading', () => {
    const { container } = wrap(<AttackOutcomeMatrix view={null} loading />);
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
  });
});

describe('failed-load states', () => {
  it('cadence shows an error body, not a skeleton', () => {
    const { container } = wrap(<TestingCadenceCard view={null} />);
    expect(screen.getByText('Testing cadence')).toBeInTheDocument();
    expect(screen.getByText(/Couldn't load testing cadence/)).toBeInTheDocument();
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });
  it('readiness shows an error body, not a skeleton', () => {
    const { container } = wrap(<ThreatActorReadinessCard view={null} />);
    expect(screen.getByText(/Couldn't load threat actor readiness/)).toBeInTheDocument();
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });
  it('matrix shows an error body, not a skeleton', () => {
    const { container } = wrap(<AttackOutcomeMatrix view={null} />);
    expect(screen.getByText(/Couldn't load ATT&CK outcomes/)).toBeInTheDocument();
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });
});

describe('small behaviours', () => {
  it('hides "/ 0" when no agents are enrolled', () => {
    const { container } = wrap(<TestingCadenceCard view={{ ...cadence, agentsTotal: 0, endpointsTested7d: 3 }} />);
    expect(container.textContent).not.toContain('/ 0');
  });
  it('caps untested actors at 6 with a +N more suffix', () => {
    const many = Array.from({ length: 9 }, (_, i) => `Actor${i}`);
    wrap(<ThreatActorReadinessCard view={{ ...actors, untestedActors: many }} />);
    expect(screen.getByText(/\+3 more/)).toBeInTheDocument();
    expect(screen.queryByText(/Actor8/)).toBeNull();
  });
});
