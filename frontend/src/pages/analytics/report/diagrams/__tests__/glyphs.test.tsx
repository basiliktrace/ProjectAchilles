import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GlyphRow, OutcomeLegend } from '../StageGlyph';
import { OutcomeBar } from '../OutcomeBar';
import { counts } from '../../__tests__/fixtures';

describe('GlyphRow', () => {
  it('draws squares for defended, circles for got-through, hollow for no verdict', () => {
    const { container } = render(
      <GlyphRow stages={[{ outcome: 'protected' }, { outcome: 'unprotected', highImpact: true }, { outcome: 'inconclusive' }]} />,
    );
    expect(container.querySelectorAll('rect')).toHaveLength(2);
    expect(container.querySelectorAll('circle')).toHaveLength(1);
    expect(container.querySelector('.rp-g-hi')).not.toBeNull();
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'Protected, Unprotected, Inconclusive');
  });

  it('caps long rows and says how many are hidden', () => {
    render(<GlyphRow stages={Array.from({ length: 20 }, () => ({ outcome: 'protected' as const }))} max={16} />);
    expect(screen.getByText('+4')).toBeInTheDocument();
  });
});

describe('OutcomeBar', () => {
  it('draws one segment per present outcome and never shows skipped', () => {
    const { container } = render(<OutcomeBar counts={counts({ protected: 3, unprotected: 1, skipped: 9 })} />);
    expect(container.querySelectorAll('.rp-seg')).toHaveLength(2);
    expect(screen.getByText('Protected')).toBeInTheDocument();
    expect(screen.queryByText('Skipped')).toBeNull();
  });

  it('labels an empty bar', () => {
    render(<OutcomeBar counts={counts()} legend={false} />);
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'No results');
  });
});

describe('OutcomeLegend', () => {
  it('lists the five outcomes and, on request, the high-impact mark', () => {
    render(<OutcomeLegend highImpact />);
    for (const label of ['Protected', 'Prevented', 'Detected', 'Unprotected', 'Inconclusive']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('Unprotected, exfiltration or impact')).toBeInTheDocument();
  });
});
