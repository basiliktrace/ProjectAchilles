import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { TestMetadata } from '@/types/test';
import { TestListHeader, TestListRow } from '../TestListRow';

const baseTest: TestMetadata = {
  uuid: 'u1',
  name: 'LockBit 3.0 Double Extortion Kill Chain',
  category: 'intel-driven',
  subcategory: 'ransomware',
  threatActor: 'LockBit 3.0',
  techniques: ['T1059.001', 'T1003.001', 'T1486', 'T1490'],
  target: ['windows-endpoint', 'linux-server'],
  isMultiStage: true,
  stages: [],
  stageCount: 5,
  score: 8.8,
};

function renderRow(overrides: Partial<ComponentProps<typeof TestListRow>> = {}, test: Partial<TestMetadata> = {}) {
  const props: ComponentProps<typeof TestListRow> = {
    test: { ...baseTest, ...test },
    fleet: { text: '9 / 12 endpoints protected', share: 0.75, title: 'Latest result per endpoint' },
    onOpen: vi.fn(),
    isFavorite: false,
    onToggleFavorite: vi.fn(),
    onExecute: vi.fn(),
    selectMode: false,
    selected: false,
    onToggleSelect: vi.fn(),
    ...overrides,
  };
  render(<TestListRow {...props} />);
  return props;
}

describe('TestListRow', () => {
  it('shows the name as a button with the full name in its title', () => {
    const props = renderRow();
    const name = screen.getByRole('button', { name: baseTest.name });
    expect(name.getAttribute('title')).toBe(baseTest.name);
    expect(name.className).toContain('truncate');
    fireEvent.click(name);
    expect(props.onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows actor · subcategory, falling back to "No attributed actor"', () => {
    renderRow({}, { threatActor: undefined });
    expect(screen.getByText('No attributed actor · ransomware')).toBeTruthy();
  });

  it('omits the separator when there is no subcategory', () => {
    renderRow({}, { subcategory: undefined });
    expect(screen.getByText('LockBit 3.0')).toBeTruthy();
  });

  it('shows the first two techniques and a +n count', () => {
    renderRow();
    expect(screen.getByText('T1059.001')).toBeTruthy();
    expect(screen.getByText('T1003.001')).toBeTruthy();
    expect(screen.queryByText('T1486')).toBeNull();
    expect(screen.getByText('+2')).toBeTruthy();
  });

  it('shows platform labels, stage count and score', () => {
    renderRow();
    expect(screen.getByText('Windows, Linux')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText('8.8')).toBeTruthy();
  });

  it('shows "—" for zero stages and a missing score', () => {
    renderRow({}, { stageCount: 0, score: undefined });
    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  it.each([0, -1])('shows "—" for a score of %s, as the old card hid it', (score) => {
    renderRow({}, { score });
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText(score.toFixed(1))).toBeNull();
  });

  it('gates techniques and stages to 2xl and platform to xl', () => {
    renderRow();
    const techniques = screen.getByText('T1059.001').parentElement!;
    expect(techniques.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(techniques.className).toContain('2xl:flex');
    const stages = screen.getByText('5');
    expect(stages.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(stages.className).toContain('2xl:block');
    const platform = screen.getByText('Windows, Linux');
    expect(platform.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(platform.className).toContain('xl:block');
    expect(platform.className).not.toContain('2xl:block');
  });

  it('keeps the score visible at every width, beside the actions', () => {
    renderRow();
    expect(screen.getByText('8.8').className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });

  it('shows the actions at full opacity on devices without hover', () => {
    renderRow();
    const actions = screen.getByRole('button', { name: `Run ${baseTest.name}` }).parentElement!;
    expect(actions.className).toContain('[@media(hover:none)]:opacity-100');
    expect(actions.className).toContain('group-focus-within:opacity-100');
  });

  it('gives the favorite and run buttons title tooltips', () => {
    renderRow();
    expect(screen.getByRole('button', { name: `Add ${baseTest.name} to favorites` }).getAttribute('title')).toBe('Add favorite');
    expect(screen.getByRole('button', { name: `Run ${baseTest.name}` }).getAttribute('title')).toBe('Run test');
  });

  it('uses no fixed minimum width', () => {
    const { container } = render(
      <ul>
        <TestListRow
          test={baseTest}
          fleet={{ text: 'x', share: null, title: '' }}
          onOpen={vi.fn()}
          isFavorite={false}
          onToggleFavorite={vi.fn()}
          selectMode={false}
          selected={false}
          onToggleSelect={vi.fn()}
        />
      </ul>,
    );
    expect(container.innerHTML).not.toContain('min-w-[');
  });

  it('renders the fleet result text and bar share', () => {
    renderRow();
    const text = screen.getByText('9 / 12 endpoints protected');
    expect(text.closest('[title]')?.getAttribute('title')).toBe('Latest result per endpoint');
    expect(screen.getByTestId('fleet-bar').style.width).toBe('75%');
  });

  it('has labelled favorite and run buttons', () => {
    const props = renderRow();
    fireEvent.click(screen.getByRole('button', { name: `Add ${baseTest.name} to favorites` }));
    expect(props.onToggleFavorite).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: `Run ${baseTest.name}` }));
    expect(props.onExecute).toHaveBeenCalledTimes(1);
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it('labels the favorite button for removal when already a favorite', () => {
    renderRow({ isFavorite: true });
    expect(screen.getByRole('button', { name: `Remove ${baseTest.name} from favorites` })).toBeTruthy();
  });

  it('hides the run button without an onExecute handler', () => {
    renderRow({ onExecute: undefined });
    expect(screen.queryByRole('button', { name: `Run ${baseTest.name}` })).toBeNull();
  });

  it('in select mode shows a checkbox and a row click toggles selection', () => {
    const props = renderRow({ selectMode: true });
    expect(screen.getByRole('checkbox', { name: `Select ${baseTest.name}` })).toBeTruthy();
    fireEvent.click(screen.getByText('Windows, Linux'));
    expect(props.onToggleSelect).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: baseTest.name }));
    expect(props.onToggleSelect).toHaveBeenCalledTimes(2);
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it('outside select mode a row click opens the test', () => {
    const props = renderRow();
    fireEvent.click(screen.getByText('Windows, Linux'));
    expect(props.onOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});

describe('TestListHeader', () => {
  it('is hidden below xl and shares the row column tracks', () => {
    const { container } = render(<TestListHeader />);
    const header = container.firstElementChild as HTMLElement;
    expect(header.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(header.className).toContain('xl:grid');
    expect(header.className).toContain('xl:grid-cols-[minmax(0,1fr)_120px_180px_48px_72px]');
    expect(header.className).toContain('2xl:grid-cols-[minmax(0,1fr)_150px_120px_56px_180px_48px_72px]');
  });

  it('shows the Techniques and Stages headers at 2xl only', () => {
    render(<TestListHeader />);
    for (const label of ['Techniques', 'Stages']) {
      const cell = screen.getByText(label);
      expect(cell.className).toMatch(/(^|\s)hidden(\s|$)/);
      expect(cell.className).toContain('2xl:block');
    }
    for (const label of ['Test', 'Platform', 'Fleet result', 'Score']) {
      expect(screen.getByText(label).className).not.toContain('hidden');
    }
  });

  it('uses the same column tracks as a row', () => {
    const { container } = render(<TestListHeader />);
    const header = container.firstElementChild as HTMLElement;
    renderRow();
    const row = screen.getAllByRole('listitem')[0];
    const tracks = (el: HTMLElement) => el.className.split(/\s+/).filter((c) => c.includes('grid-cols-'));
    expect(tracks(row)).toEqual(tracks(header));
  });
});
