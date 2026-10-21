import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RunList } from '../RunList';
import type { DisplayRow } from '../shared';
import type { EnrichedTestExecution } from '@/services/api/analytics';

function standalone(key: string, name: string): DisplayRow {
  return {
    type: 'standalone',
    key,
    execution: {
      test_uuid: key,
      test_name: name,
      hostname: 'host-1',
      timestamp: '2026-10-12T12:47:49Z',
      error_code: 101,
    } as EnrichedTestExecution,
  };
}

const rows = [standalone('a', 'Alpha test'), standalone('b', 'Bravo test')];

describe('RunList selection', () => {
  it('gives the open run an accent wash, an inset accent bar and a stronger title', () => {
    render(<RunList rows={rows} selectedKey="b" onSelect={vi.fn()} checkedKeys={null} onToggleChecked={vi.fn()} />);
    const selected = screen.getByRole('option', { name: /Bravo test/ });
    expect(selected).toHaveAttribute('aria-selected', 'true');
    expect(selected.className).toContain('bg-accent-dim');
    expect(selected.className).toContain('shadow-[inset_3px_0_0_var(--color-accent)]');
    expect(screen.getByText('Bravo test').className).toContain('text-foreground');
  });

  it('keeps unselected runs on the quiet hover style, distinct from the selection', () => {
    render(<RunList rows={rows} selectedKey="b" onSelect={vi.fn()} checkedKeys={null} onToggleChecked={vi.fn()} />);
    const other = screen.getByRole('option', { name: /Alpha test/ });
    expect(other).toHaveAttribute('aria-selected', 'false');
    expect(other.className).not.toContain('bg-accent-dim');
    expect(other.className).not.toContain('inset_3px');
    expect(other.className).toContain('hover:bg-raised/60');
  });
});
