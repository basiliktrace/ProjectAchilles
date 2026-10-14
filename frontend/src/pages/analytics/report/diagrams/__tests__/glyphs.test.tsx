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

  it('folds stages that were not fetched into one count beside the hidden ones', () => {
    const sixty = Array.from({ length: 60 }, () => ({ outcome: 'protected' as const }));
    const { container } = render(<GlyphRow stages={sixty} max={16} notFetched={10} />);
    const more = container.querySelectorAll('.rp-more');
    expect(more).toHaveLength(1);
    expect(more[0]).toHaveTextContent('+44 (+10 not fetched)');
  });

  it('puts the count below the glyph row, never inside the row that sets the cell width', () => {
    const sixty = Array.from({ length: 60 }, () => ({ outcome: 'protected' as const }));
    const { container } = render(<GlyphRow stages={sixty} max={16} notFetched={10} />);
    const note = container.querySelector('.rp-more') as HTMLElement;
    const svg = container.querySelector('svg') as SVGElement;
    const row = container.querySelector('.rp-glyph-row') as HTMLElement;
    expect(row.contains(svg)).toBe(true);
    expect(row.contains(note)).toBe(false);
    expect(note.parentElement).not.toBe(svg.parentElement);
  });

  it('puts the hidden-glyph count below the row too when nothing was left unfetched', () => {
    const { container } = render(<GlyphRow stages={Array.from({ length: 20 }, () => ({ outcome: 'protected' as const }))} max={16} />);
    expect(container.querySelector('.rp-glyph-row')!.contains(screen.getByText('+4'))).toBe(false);
  });

  it('says only what was not fetched when every fetched stage is drawn', () => {
    const { container } = render(<GlyphRow stages={[{ outcome: 'protected' }]} notFetched={7} />);
    expect(container.querySelector('.rp-more')).toHaveTextContent(/^\(\+7 not fetched\)$/);
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
