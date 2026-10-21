import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { TestMetadata } from '@/types/test';
import { TestListRow } from '../TestListRow';

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
