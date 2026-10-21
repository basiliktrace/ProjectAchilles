import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChainDepthCard from '../ChainDepthCard';
import type { ChainDepthResponse } from '@/services/api/analytics';

const data: ChainDepthResponse = {
  chains: 8,
  buckets: [
    { stage: 1, blocked: 1, alertedNotBlocked: 0, bundleNames: ['APT29 Chain'] },
    { stage: 2, blocked: 0, alertedNotBlocked: 0, bundleNames: [] },
    { stage: 3, blocked: 1, alertedNotBlocked: 1, bundleNames: ['Lazarus Chain'] },
    { stage: 4, blocked: 3, alertedNotBlocked: 0, bundleNames: ['FIN7 Chain', 'Lazarus Chain'] },
  ],
  endToEnd: 3,
  endToEndAlerted: 1,
  endToEndBundleNames: ['APT29 Chain', 'FIN7 Chain'],
  inconclusive: 0,
};

describe('ChainDepthCard', () => {
  it('renders one row per stage plus end to end, with chain counts', () => {
    render(<ChainDepthCard data={data} />);
    expect(screen.getByText('How deep attack chains get')).toBeInTheDocument();
    expect(screen.getByText('8 chains')).toBeInTheDocument();
    const rows = screen.getAllByRole('button');
    expect(rows.map((r) => within(r).getAllByText(/./)[0].textContent)).toEqual([
      'Stage 1',
      'Stage 2',
      'Stage 3',
      'Stage 4+',
      'Ran end to end',
    ]);
    expect(within(rows[0]).getByText('1 chain')).toBeInTheDocument();
    expect(within(rows[3]).getByText('3 chains')).toBeInTheDocument();
    expect(within(rows[4]).getByText('3 chains')).toBeInTheDocument();
  });

  it('rows are buttons with accessible names that include the alerted count', () => {
    render(<ChainDepthCard data={data} />);
    expect(
      screen.getByRole('button', { name: 'Stage 3: 1 chain blocked, 1 after an earlier EDR alert. Show these runs' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Ran end to end: 3 chains, 1 with an EDR alert. Show these runs' }),
    ).toBeInTheDocument();
  });

  it('clicking a row passes that bucket’s bundle names', async () => {
    const onRowClick = vi.fn();
    render(<ChainDepthCard data={data} onRowClick={onRowClick} />);
    await userEvent.click(screen.getByRole('button', { name: /^Stage 4\+/ }));
    expect(onRowClick).toHaveBeenLastCalledWith(['FIN7 Chain', 'Lazarus Chain']);
    await userEvent.click(screen.getByRole('button', { name: /^Ran end to end/ }));
    expect(onRowClick).toHaveBeenLastCalledWith(['APT29 Chain', 'FIN7 Chain']);
  });

  it('rows without chains are disabled', async () => {
    const onRowClick = vi.fn();
    render(<ChainDepthCard data={data} onRowClick={onRowClick} />);
    const empty = screen.getByRole('button', { name: /^Stage 2/ });
    expect(empty).toBeDisabled();
    await userEvent.click(empty);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('bars scale to the largest row; the alerted share is its own segment', () => {
    render(<ChainDepthCard data={data} />);
    const stage3 = screen.getByRole('button', { name: /^Stage 3/ });
    expect(stage3.querySelector<HTMLElement>('[data-segment="main"]')?.style.width).toBe('0%');
    expect(stage3.querySelector<HTMLElement>('[data-segment="alerted"]')?.style.width).toBe(`${(1 / 3) * 100}%`);
    const stage4 = screen.getByRole('button', { name: /^Stage 4\+/ });
    expect(stage4.querySelector<HTMLElement>('[data-segment="main"]')?.style.width).toBe('100%');
    const e2e = screen.getByRole('button', { name: /^Ran end to end/ });
    expect(e2e.querySelector<HTMLElement>('[data-segment="main"]')?.style.backgroundColor).toBe('var(--chart-bypassed)');
  });

  it('shows the empty state when there are no chains', () => {
    render(
      <ChainDepthCard
        data={{
          chains: 0,
          buckets: [1, 2, 3, 4].map((stage) => ({ stage: stage as 1 | 2 | 3 | 4, blocked: 0, alertedNotBlocked: 0, bundleNames: [] })),
          endToEnd: 0,
          endToEndAlerted: 0,
          endToEndBundleNames: [],
          inconclusive: 0,
        }}
      />,
    );
    expect(screen.getByText('No multi-stage chains in this window')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('notes inconclusive chains in the footer and keeps them out of the rows', () => {
    render(<ChainDepthCard data={{ ...data, inconclusive: 2 }} />);
    expect(
      screen.getByText('2 chains inconclusive — a stage errored or was blocked before it ran — not shown'),
    ).toBeInTheDocument();
    expect(screen.getByText('8 chains')).toBeInTheDocument();
  });

  it('with only inconclusive chains it shows the footer, not the empty state', () => {
    render(
      <ChainDepthCard
        data={{
          chains: 0,
          buckets: [1, 2, 3, 4].map((stage) => ({ stage: stage as 1 | 2 | 3 | 4, blocked: 0, alertedNotBlocked: 0, bundleNames: [] })),
          endToEnd: 0,
          endToEndAlerted: 0,
          endToEndBundleNames: [],
          inconclusive: 1,
        }}
      />,
    );
    expect(screen.queryByText('No multi-stage chains in this window')).not.toBeInTheDocument();
    expect(
      screen.getByText('1 chain inconclusive — a stage errored or was blocked before it ran — not shown'),
    ).toBeInTheDocument();
  });

  it('says nothing about inconclusive chains when there are none', () => {
    render(<ChainDepthCard data={data} />);
    expect(screen.queryByText(/inconclusive/)).not.toBeInTheDocument();
  });

  it('shows the error state when the fetch failed', () => {
    render(<ChainDepthCard data={null} />);
    expect(screen.getByText("Couldn't load chain depth")).toBeInTheDocument();
  });

  it('renders only a skeleton while loading', () => {
    const { container } = render(<ChainDepthCard data={null} loading />);
    expect(screen.queryByText('How deep attack chains get')).not.toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});
