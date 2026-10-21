import { describe, expect, it } from 'vitest';
import type React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ActorReadinessView } from '../../dashboardViews';
import { FleetHealthCard } from '../FleetHealthCard';
import { KpiGrid } from '../KpiGrid';
import { RecentExecutionsCard, type RecentExecution } from '../RecentExecutionsCard';
import { ThreatActorReadinessCard } from '../ThreatActorReadinessCard';
import { TopControlsCard, type RemediationControl } from '../TopControlsCard';

// jsdom has no ResizeObserver, so fit lists render their fallback count.
const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('KpiGrid', () => {
  it('takes its large-screen column count from the number of tiles', () => {
    const { container } = render(
      <KpiGrid>
        {[1, 2, 3, 4, 5, 6].map((n) => <div key={n}>tile {n}</div>)}
      </KpiGrid>,
    );
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.style.getPropertyValue('--kpi-cols')).toBe('6');
  });
});

describe('fit lists fall back to their default count when nothing can be measured', () => {
  it('TopControlsCard renders 5 of 10 controls', () => {
    const controls: RemediationControl[] = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`,
      title: `Control ${i}`,
      scoreImpact: '+1.00',
    }));
    wrap(<TopControlsCard controls={controls} configured />);
    expect(screen.getAllByText(/^Control \d$/)).toHaveLength(5);
  });

  it('RecentExecutionsCard renders 6 of 12 executions', () => {
    const executions: RecentExecution[] = Array.from({ length: 12 }, (_, i) => ({
      id: `e${i}`,
      testName: `Exec ${i}`,
      status: 'completed',
      timeAgo: '1h ago',
      to: '/tasks',
    }));
    wrap(<RecentExecutionsCard executions={executions} configured />);
    expect(screen.getAllByText(/^Exec \d+$/)).toHaveLength(6);
  });

  it('ThreatActorReadinessCard renders 7 of 9 actors', () => {
    const view: ActorReadinessView = {
      rows: Array.from({ length: 9 }, (_, i) => ({
        threatActor: `Actor ${i}`,
        score: 50 + i,
        pairCount: 3,
        testCount: 1,
        exposed: true,
        lastTestedAt: null,
        daysAgo: null,
        stale: false,
      })),
      totalActors: 9,
      exposedCount: 9,
      untestedActors: [],
      rangeLabel: 'the last 30d',
      empty: false,
    };
    wrap(<ThreatActorReadinessCard configured view={view} />);
    expect(screen.getAllByText(/^Actor \d$/)).toHaveLength(7);
  });
});

describe('FleetHealthCard', () => {
  it('shows stale and outdated agent rows', () => {
    wrap(
      <FleetHealthCard
        stats={[]}
        rows={[{ label: 'windows', count: 36, pct: 100 }]}
        staleAgents={5}
        outdatedAgents={2}
        totalAgents={36}
      />,
    );
    expect(screen.getByText('Stale (no task in 7d)')).toBeInTheDocument();
    expect(screen.getByText('Outdated agents')).toBeInTheDocument();
  });
});
