import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FacetRail } from '../FacetRail';
import { DEFAULT_FILTERS, type FacetCounts } from '../../filterTests';

const counts: FacetCounts = {
  total: 3,
  categories: [
    { value: 'intel-driven', count: 2 },
    { value: 'cyber-hygiene', count: 1 },
  ],
  targets: [{ value: 'windows-endpoint', count: 3 }],
  threatActors: [],
};

function renderRail(category: string | null = null) {
  return render(
    <FacetRail
      counts={counts}
      filters={{ ...DEFAULT_FILTERS, category }}
      showNotRunYet={false}
      showHasBinary={false}
      onChange={vi.fn()}
    />,
  );
}

describe('FacetRail', () => {
  it('has no Severity section', () => {
    renderRail();
    expect(screen.queryByText('Severity')).toBeNull();
  });

  it('marks the active option with the accent-dim wash', () => {
    renderRail('intel-driven');
    const active = screen.getByText('intel-driven').closest('button')!;
    expect(active.className).toContain('bg-accent-dim');
    expect(active.className).toContain('text-accent');
  });

  it('renders inactive options as plain rows with no border or background', () => {
    renderRail('intel-driven');
    const inactive = screen.getByText('cyber-hygiene').closest('button')!;
    expect(inactive.className).not.toMatch(/(^|\s)border(\s|-|$)/);
    expect(inactive.className).not.toMatch(/(^|\s)bg-(?!transparent)/);
  });

  it('shows a visible keyboard focus ring on options', () => {
    renderRail('intel-driven');
    for (const label of ['intel-driven', 'cyber-hygiene']) {
      const cls = screen.getByText(label).closest('button')!.className;
      expect(cls).toContain('focus-visible:ring-1');
      expect(cls).toContain('focus-visible:ring-accent');
    }
  });

  it('washes inactive rows on hover only', () => {
    renderRail('intel-driven');
    const cls = screen.getByText('cyber-hygiene').closest('button')!.className;
    expect(cls).toContain('hover:bg-raised/50');
  });
});
