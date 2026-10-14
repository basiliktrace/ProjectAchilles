import type { ExecutionReport, ReportTechnique } from '@/services/api/reports';
import { BAND_LABEL, bandOf, conclusive, defended, protectionRate } from '../lib/outcomes';
import { fmtCount, fmtPct, plural } from '../lib/format';
import { OutcomeBar } from '../diagrams/OutcomeBar';
import { Sheet, type SheetHead } from './Sheet';
import { testNamesText } from './scope';

const ACTORS_SHOWN = 6;
const TECHNIQUES_PER_ACTOR = 8;

export function ActorsAndCoverage({ report, head }: { report: ExecutionReport; head: SheetHead }) {
  // Techniques from the stages of the actor's tests; a test without its own page has no stages,
  // so then from the coverage table's techniques that those tests exercised.
  const techniquesOf = (keys: string[]) => {
    const fromStages = report.tests.filter((t) => keys.includes(t.testKey)).flatMap((t) => t.stages.flatMap((s) => s.techniques));
    const ids = fromStages.length > 0
      ? fromStages
      : report.techniques.filter((t) => t.testKeys.some((k) => keys.includes(k))).map((t) => t.id);
    return [...new Set(ids)];
  };
  const actors = [...report.actors].sort((a, b) => b.runs - a.runs).slice(0, ACTORS_SHOWN);

  // Techniques arrive sorted in kill-chain order (unknown tactic last).
  const groups: { tactic: string; techniques: ReportTechnique[] }[] = [];
  for (const t of report.techniques) {
    const tactic = t.tactic ?? 'Other';
    const last = groups[groups.length - 1];
    if (last && last.tactic === tactic) last.techniques.push(t);
    else groups.push({ tactic, techniques: [t] });
  }

  return (
    <Sheet label="Threat actors and ATT&CK coverage" head={head}>
      <div>
        <h2 className="rp-h2">Threat actors and ATT&amp;CK coverage</h2>
        <p className="rp-muted">Actors come from test metadata. Techniques are grouped by tactic in kill-chain order.</p>
      </div>
      {report.actors.length > actors.length && (
        <h3 className="rp-h3">Top {actors.length} of {report.actors.length} threat actors by runs</h3>
      )}
      {actors.length > 0 ? (
        <div className="rp-grid-2">
          {actors.map((a) => {
            const techniques = techniquesOf(a.testKeys);
            return (
              <div key={a.name} className="rp-card rp-avoid">
                <h3 className="rp-h3">{a.name}</h3>
                <dl className="rp-kv">
                  <dt>Emulated by</dt>
                  <dd>{testNamesText(report, a.testKeys)}</dd>
                  <dt>Runs</dt>
                  <dd>{fmtCount(a.runs)}</dd>
                  <dt>Techniques</dt>
                  <dd className="rp-mono">
                    {techniques.slice(0, TECHNIQUES_PER_ACTOR).join(' · ')}
                    {techniques.length > TECHNIQUES_PER_ACTOR ? ` +${techniques.length - TECHNIQUES_PER_ACTOR}` : ''}
                  </dd>
                  <dt>Stage protection rate</dt>
                  <dd><b className="rp-mono">{fmtPct(protectionRate(a.outcomes))}</b></dd>
                </dl>
                <OutcomeBar counts={a.outcomes} legend={false} height={6} />
              </div>
            );
          })}
        </div>
      ) : (
        <p className="rp-muted">No threat actor is attributed to the tests in this scope.</p>
      )}
      <div>
        <h3 className="rp-h3">Coverage by technique <small>Held ≥ 75% · Partial 40–74% · Gap &lt; 40% stage protection rate</small></h3>
        {groups.map((g) => (
          <div key={g.tactic} className="rp-attack-row rp-avoid">
            <div className="rp-h3">{g.tactic}</div>
            <div className="rp-attack-cells">
              {g.techniques.map((t) => {
                const rate = protectionRate(t.outcomes);
                const band = bandOf(rate);
                return (
                  <div key={t.id} className={`rp-attack-cell rp-band-${band}`}>
                    <div className="rp-h3"><span className="rp-mono">{t.id}</span><small>{BAND_LABEL[band]}</small></div>
                    <div className="rp-muted">{t.name ?? 'Unknown technique'}</div>
                    <OutcomeBar counts={t.outcomes} legend={false} height={5} />
                    <div className="rp-muted"><b className="rp-mono">{fmtPct(rate)}</b> · {defended(t.outcomes)} of {conclusive(t.outcomes)} stage results</div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {report.otherTests.length > 0 && (
        <div>
          <h3 className="rp-h3">Other tests in scope <small>{plural(report.otherTests.length, 'test')} without their own page</small></h3>
          <table className="rp-table">
            <thead><tr><th>Test</th><th className="rp-num">Runs</th><th>Outcomes</th><th className="rp-num">Stage protection rate</th></tr></thead>
            <tbody>
              {report.otherTests.map((t) => (
                <tr key={t.testKey}>
                  <td>{t.name}</td>
                  <td className="rp-num">{fmtCount(t.runs)}</td>
                  <td style={{ width: '30%' }}><OutcomeBar counts={t.outcomes} legend={false} height={6} /></td>
                  <td className="rp-num">{fmtPct(protectionRate(t.outcomes))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Sheet>
  );
}
