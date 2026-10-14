import type { StageOutcome } from '@/services/api/reports';
import { COUNTED_OUTCOMES, OUTCOME_LABEL, shapeOf } from '../lib/outcomes';

export interface GlyphDatum {
  outcome: StageOutcome;
  highImpact?: boolean;
}

/** One outcome mark at (x, y). Squares = defended, circles = got through, hollow = no verdict. */
export function Glyph({ outcome, highImpact = false, x, y, size }: GlyphDatum & { x: number; y: number; size: number }) {
  const className = `rp-g rp-g-${outcome}${highImpact ? ' rp-g-hi' : ''}`;
  const shape = shapeOf(outcome);
  if (shape === 'circle') return <circle className={className} cx={x + size / 2} cy={y + size / 2} r={size / 2} />;
  if (shape === 'hollow') return <rect className={className} x={x + 0.75} y={y + 0.75} width={size - 1.5} height={size - 1.5} rx={1} />;
  return <rect className={className} x={x} y={y} width={size} height={size} rx={1} />;
}

export function GlyphIcon({ outcome, highImpact, size = 9 }: GlyphDatum & { size?: number }) {
  return (
    <svg className="rp-glyph-icon" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <Glyph outcome={outcome} highImpact={highImpact} x={0} y={0} size={size} />
    </svg>
  );
}

/**
 * Up to `max` glyphs, then one count: "+44" for glyphs not drawn and, when the run has stages the
 * backend did not fetch, "(+10 not fetched)" (the run strip's wording). The count sits on its own line
 * under the glyphs, so only the glyph row sets the width of the cell it is in.
 */
export function GlyphRow({ stages, size = 8, gap = 3, max = 16, notFetched = 0 }: {
  stages: GlyphDatum[];
  size?: number;
  gap?: number;
  max?: number;
  notFetched?: number;
}) {
  const shown = stages.slice(0, max);
  const width = Math.max(size, shown.length * (size + gap) - gap);
  const more = [
    stages.length > max ? `+${(stages.length - max).toLocaleString('en-US')}` : '',
    notFetched > 0 ? `(+${notFetched.toLocaleString('en-US')} not fetched)` : '',
  ].filter(Boolean).join(' ');
  return (
    <>
      <span className="rp-glyph-row">
        <svg width={width} height={size} viewBox={`0 0 ${width} ${size}`} role="img" aria-label={shown.map((s) => OUTCOME_LABEL[s.outcome]).join(', ')}>
          {shown.map((s, i) => (
            <Glyph key={i} outcome={s.outcome} highImpact={s.highImpact} x={i * (size + gap)} y={0} size={size} />
          ))}
        </svg>
      </span>
      {more && <span className="rp-more">{more}</span>}
    </>
  );
}

export function OutcomeLegend({ highImpact = false }: { highImpact?: boolean }) {
  return (
    <div className="rp-legend">
      {COUNTED_OUTCOMES.map((o) => (
        <span key={o}>
          <GlyphIcon outcome={o} />
          <span>{OUTCOME_LABEL[o]}</span>
        </span>
      ))}
      {highImpact && (
        <span>
          <GlyphIcon outcome="unprotected" highImpact />
          <span>Unprotected, exfiltration or impact</span>
        </span>
      )}
    </div>
  );
}
