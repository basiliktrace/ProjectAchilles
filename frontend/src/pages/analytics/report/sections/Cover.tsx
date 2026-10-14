import type { ExecutionReport } from '@/services/api/reports';
import { fmtCount, fmtDateTime, plural, tzName } from '../lib/format';
import { describeOutcomeFilters } from '../lib/verdict';
import { GLYPH, RunColumn, STACK_HEIGHT } from '../diagrams/CampaignTimeline';
import { OutcomeLegend } from '../diagrams/StageGlyph';
import { Sheet } from './Sheet';
import { PartialBanner, ScopeList, orgLabel, windowText } from './scope';

const STRIP_W = 680;
/** One column per run, each at least a glyph wide plus a 1-unit gap, so no glyph overlaps its neighbour. */
const STRIP_MAX_RUNS = Math.floor(STRIP_W / (GLYPH + 1));

function CoverStrip({ report }: { report: ExecutionReport }) {
  if (report.meta.truncation.runs || report.runs.length === 0 || report.runs.length > STRIP_MAX_RUNS) return null;
  const runs = [...report.runs].sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  const col = STRIP_W / runs.length;
  return (
    <figure className="rp-figure">
      <svg className="rp-svg" viewBox={`0 0 ${STRIP_W} ${STACK_HEIGHT}`} role="img" aria-label="Every run in the report, oldest first">
        {runs.map((r, i) => <RunColumn key={r.key} run={r} x={i * col + col / 2} top={0} />)}
      </svg>
      <figcaption className="rp-caption">
        {plural(runs.length, 'run')} · {fmtCount(report.totals.stageResults)} stage results · one column per run, oldest first
      </figcaption>
      <OutcomeLegend highImpact />
    </figure>
  );
}

export function Cover({ report, marking }: { report: ExecutionReport; marking: string }) {
  const { meta } = report;
  const tz = meta.tz;
  const outcomeFilter = describeOutcomeFilters(report);
  return (
    <Sheet label="Cover">
      <div className="rp-cover">
        <div className="rp-cover-brand">
          <span className="rp-wordmark">PROJECT ACHILLES</span>
          <span className="rp-muted">Continuous security validation</span>
        </div>
        <div>
          <p className="rp-muted">Adversary emulation results</p>
          <h1 className="rp-h1">Security Validation Report</h1>
          <p className="rp-cover-org">{orgLabel(report)}</p>
          <p className="rp-muted">{`${meta.window.label} · ${windowText(report)}`}</p>
        </div>
        {outcomeFilter && (
          <div className="rp-banner" role="note">
            Filtered by outcome: {outcomeFilter}. Rates in this report describe that subset, not overall defensive posture.
          </div>
        )}
        <PartialBanner report={report} />
        <CoverStrip report={report} />
        <div className="rp-grid-2">
          <ScopeList report={report} />
          <dl className="rp-kv">
            <dt>Report ID</dt>
            <dd className="rp-mono">{meta.reportId}</dd>
            <dt>Generated</dt>
            <dd>{fmtDateTime(meta.generatedAt, tz)} {tzName(meta.generatedAt, tz)}</dd>
            <dt>Handling</dt>
            <dd>{marking === 'None' ? 'Not marked' : <span className="rp-marking">{marking}</span>}</dd>
          </dl>
        </div>
      </div>
    </Sheet>
  );
}
