import type { OutcomeCounts } from '@/services/api/reports';
import { COUNTED_OUTCOMES, OUTCOME_LABEL } from '../lib/outcomes';
import { GlyphIcon } from './StageGlyph';

/** 100% bar of stage outcomes. Skipped stages are never drawn: they are not results. */
export function OutcomeBar({ counts, legend = true, height = 12 }: { counts: OutcomeCounts; legend?: boolean; height?: number }) {
  const present = COUNTED_OUTCOMES.filter((o) => counts[o] > 0);
  const label = present.map((o) => `${OUTCOME_LABEL[o]} ${counts[o]}`).join(', ') || 'No results';
  return (
    <div className="rp-obar">
      <div className="rp-obar-track" style={{ height }} role="img" aria-label={label}>
        {present.map((o) => (
          <span key={o} className={`rp-seg rp-seg-${o}`} style={{ flexGrow: counts[o] }} />
        ))}
      </div>
      {legend && present.length > 0 && (
        <div className="rp-legend">
          {present.map((o) => (
            <span key={o}>
              <GlyphIcon outcome={o} />
              <span>{OUTCOME_LABEL[o]}</span>
              <b>{counts[o].toLocaleString('en-US')}</b>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
