import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AttackChainStrip } from '../AttackChainStrip';
import type { EnrichedTestExecution } from '@/services/api/analytics';

function stage(n: number, over: Partial<EnrichedTestExecution> = {}): EnrichedTestExecution {
  return {
    test_uuid: `b::T${n}`,
    test_name: `Stage name ${n}`,
    hostname: 'h',
    is_protected: false,
    org: 'o',
    timestamp: '2026-10-12T12:47:49Z',
    error_code: 101,
    category: 'intel-driven',
    is_bundle_control: true,
    bundle_id: 'b',
    control_validator: `Stage ${n}`,
    ...over,
  };
}

const STAGES = [
  stage(1, { control_id: 'T1059.001', defender_stage_detected: true }),
  stage(2, { control_id: 'T1003.001', error_code: 126 }),
  stage(3, { control_id: 'T1021.002' }),
  stage(4, { control_id: 'T9999.999', error_code: 260 }),
  stage(5, { control_id: 'T1486', error_code: 999 }),
];

describe('AttackChainStrip', () => {
  it('renders one button per stage, in the given order, named "Stage N, <name>: <outcome>"', () => {
    render(<AttackChainStrip stages={STAGES} selectedIndex={null} onSelect={vi.fn()} />);
    const buttons = within(screen.getByRole('list', { name: 'Attack chain' })).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Stage 1, Stage name 1: Detected',
      'Stage 2, Stage name 2: Protected',
      'Stage 3, Stage name 3: Unprotected',
      'Stage 4, Stage name 4: Stage not run',
      'Stage 5, Stage name 5: Inconclusive',
    ]);
  });

  it('shows the technique ID and name under each node; an unknown ID renders bare', () => {
    render(<AttackChainStrip stages={STAGES} selectedIndex={null} onSelect={vi.fn()} />);
    const first = screen.getByRole('button', { name: /^Stage 1,/ });
    expect(first).toHaveTextContent('T1059.001');
    expect(first).toHaveTextContent('Stage name 1');
    const unknown = screen.getByRole('button', { name: /^Stage 4,/ });
    expect(unknown).toHaveTextContent('T9999.999');
    expect(unknown).not.toHaveTextContent('undefined');
    expect(unknown).toHaveTextContent('Stage not run');
  });

  it('falls back to the position when the validator is not "Stage N"', () => {
    render(
      <AttackChainStrip
        stages={[stage(1, { control_validator: 'Recon' }), stage(2, { control_validator: undefined })]}
        selectedIndex={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /^Stage 1, Stage name 1:/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Stage 2, Stage name 2:/ })).toBeInTheDocument();
  });

  it('calls onSelect with the index and marks the selected node as the current step', async () => {
    const onSelect = vi.fn();
    render(<AttackChainStrip stages={STAGES} selectedIndex={2} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('button', { name: /^Stage 5,/ }));
    expect(onSelect).toHaveBeenCalledWith(4);
    expect(screen.getByRole('button', { name: /^Stage 3,/ })).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('button', { name: /^Stage 1,/ })).not.toHaveAttribute('aria-current');
  });

  it('gives every node a touch target at least 44px tall and scrolls inside its own box', () => {
    render(<AttackChainStrip stages={STAGES} selectedIndex={null} onSelect={vi.fn()} />);
    for (const b of screen.getAllByRole('button')) expect(b).toHaveClass('min-h-11');
    expect(screen.getByRole('list', { name: 'Attack chain' }).parentElement).toHaveClass('overflow-x-auto');
  });
});
