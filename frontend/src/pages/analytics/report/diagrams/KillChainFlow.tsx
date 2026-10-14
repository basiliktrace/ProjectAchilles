// Kill-chain flow for multi-stage attack tests: one chevron per stage,
// banded by stage protection rate, with per-stage results below.
import type { ReportTest } from '@/services/api/reports';
import { BAND_LABEL, bandOf, conclusive, defended, protectionRate, tacticLabel } from '../lib/outcomes';
import { fmtPct } from '../lib/format';
import { OutcomeBar } from './OutcomeBar';

const W = 680;
const H = 50;
const NOTCH = 12;
const PER_ROW = 6;

export function KillChainFlow({ test }: { test: ReportTest }) {
  const rows: ReportTest['stages'][] = [];
  for (let i = 0; i < test.stages.length; i += PER_ROW) rows.push(test.stages.slice(i, i + PER_ROW));
  // Every row uses the first row's column width, so a short last row keeps full-size chevrons.
  const columns = Math.min(PER_ROW, test.stages.length);
  const cw = W / columns;

  return (
    <div className="rp-killchain">
      {rows.map((row, r) => (
        <div key={r} className="rp-avoid">
          <svg className="rp-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Stages ${row[0].order} to ${row[row.length - 1].order}`}>
            {row.map((s, i) => {
              const x0 = i * cw;
              const first = r === 0 && i === 0;
              const points = first
                ? [[x0, 0], [x0 + cw - NOTCH, 0], [x0 + cw, H / 2], [x0 + cw - NOTCH, H], [x0, H]]
                : [[x0, 0], [x0 + cw - NOTCH, 0], [x0 + cw, H / 2], [x0 + cw - NOTCH, H], [x0, H], [x0 + NOTCH, H / 2]];
              const tx = x0 + (first ? 10 : NOTCH + 8);
              const band = bandOf(protectionRate(s.outcomes));
              return (
                <g key={s.order}>
                  <polygon className={`rp-kc rp-kc-${band}`} points={points.map((p) => p.join(',')).join(' ')} />
                  <text className="rp-tick" stroke="none" x={tx} y={15}>S{s.order}</text>
                  <text className="rp-lab rp-mono" stroke="none" x={tx} y={30}>{s.techniques[0] ?? s.controlId ?? ''}</text>
                  <text className="rp-sub" stroke="none" x={tx} y={42}>{BAND_LABEL[band]}</text>
                </g>
              );
            })}
          </svg>
          <div className="rp-kc-cols" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
            {row.map((s) => (
              <div key={s.order} className="rp-kc-col">
                <div className="rp-kc-name">{s.name}</div>
                <div className="rp-kc-rate">{fmtPct(protectionRate(s.outcomes))}</div>
                <OutcomeBar counts={s.outcomes} legend={false} height={6} />
                <div className="rp-kc-sub">
                  {s.tactics[0] ? tacticLabel(s.tactics[0]) : 'No tactic'} · {defended(s.outcomes)} of {conclusive(s.outcomes)} defended
                  <br />
                  Alerts: Defender {s.alerts.defender} · Falcon {s.alerts.crowdstrike}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
