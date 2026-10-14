import type { ExecutionReport } from '@/services/api/reports';
import { conclusive, defended, protectionRate } from '../lib/outcomes';
import { fmtDate, fmtPct, plural } from '../lib/format';
import { LatencyDotPlot } from '../diagrams/LatencyDotPlot';
import { Sheet, type SheetHead } from './Sheet';
import { AlertsIncompleteNote, testNamesText } from './scope';

const HELD_MIN_RESULTS = 5;
const HELD_RATE = 0.9;

function AlertLatency({ report }: { report: ExecutionReport }) {
  const { runs } = report;
  // A run whose alerts were not searched is unknown, not silent, so the tally counts against checked runs only.
  const silent = runs.filter((r) => r.alerts.length === 0 && r.alertsChecked).length;
  const unchecked = runs.filter((r) => !r.alertsChecked).length;
  const checked = runs.length - unchecked;
  const anyAlerts = runs.some((r) => r.alerts.length > 0);
  const none = anyAlerts ? null : unchecked === 0 ? 'No EDR alert was correlated to these runs.' : unchecked < runs.length ? 'No EDR alert was found.' : null;

  return (
    <div className="rp-avoid">
      <h3 className="rp-h3">
        Time to first EDR alert
        {checked > 0 && (
          <small>{silent} of {plural(checked, 'checked run')} raised no alert{report.meta.truncation.runs ? ' (newest runs only)' : ''}</small>
        )}
      </h3>
      <AlertsIncompleteNote report={report} />
      {anyAlerts && <LatencyDotPlot runs={runs} />}
      {none && <p className="rp-muted">{none}</p>}
      {unchecked > 0 && <p className="rp-caption">Alerts were not checked for {unchecked} of {plural(runs.length, 'run')}.</p>}
    </div>
  );
}

function AcceptedRisks({ report }: { report: ExecutionReport }) {
  const tz = report.meta.tz;
  const risks = report.acceptedRisks;
  // Not permitted (null) leaves the section out; a failed lookup says so rather than "none".
  const unavailable = report.meta.unavailable.includes('acceptedRisks');
  if (!unavailable && risks === null) return null;

  return (
    <div className="rp-avoid">
      <h3 className="rp-h3">Accepted risks</h3>
      {unavailable || risks === null ? (
        <p className="rp-muted">Accepted risks unavailable — see the notice on the summary page.</p>
      ) : risks.length === 0 ? (
        <p className="rp-muted">No active accepted risks for the tests in this scope.</p>
      ) : (
        <table className="rp-table">
          <thead><tr><th>Test or stage</th><th>Scope</th><th>Reason</th><th>Accepted by</th><th className="rp-num">On</th></tr></thead>
          <tbody>
            {risks.map((r, i) => (
              <tr key={i}>
                <td>{r.testName}{r.controlId ? <span className="rp-mono"> · {r.controlId}</span> : null}</td>
                <td className="rp-id">{r.scope === 'host' ? <span className="rp-mono">{r.hostname}</span> : 'All endpoints'}</td>
                <td>{r.justification}</td>
                <td>{r.acceptedBy}</td>
                <td className="rp-num">{fmtDate(r.acceptedAt, tz)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function Findings({ report, head }: { report: ExecutionReport; head: SheetHead }) {
  const held = report.techniques
    .map((t) => ({ t, n: conclusive(t.outcomes), rate: protectionRate(t.outcomes) }))
    .filter((x) => x.n >= HELD_MIN_RESULTS && (x.rate ?? 0) >= HELD_RATE)
    .sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0) || b.n - a.n)
    .slice(0, 3);

  return (
    <Sheet label="Findings and recommendations" head={head}>
      <div>
        <h2 className="rp-h2">Findings and recommendations</h2>
        <p className="rp-muted">Techniques below a 75% stage protection rate with at least 3 results, ranked by how often the stage got through and weighted toward exfiltration and impact.</p>
      </div>
      {report.findings.length === 0 ? (
        <p>No technique fell below the threshold in this scope.</p>
      ) : (
        <ol className="rp-findings">
          {report.findings.map((f, i) => (
            <li key={f.techniqueId} className="rp-finding rp-avoid">
              <span className="rp-finding-rank">{i + 1}</span>
              <div>
                <h3 className="rp-h3">
                  <span><span className="rp-mono">{f.techniqueId}</span> {f.techniqueName ?? ''}</span>
                  <span className="rp-chips">
                    {f.highImpact && <span className="rp-chip rp-chip-strong">high impact</span>}
                    {f.acceptedRisk && <span className="rp-chip">accepted risk</span>}
                  </span>
                </h3>
                <p className="rp-muted">
                  {f.tactic ?? 'Unknown tactic'} · got through on {f.outcomes.unprotected} of {conclusive(f.outcomes)} conclusive results · {f.outcomes.detected} detected, {f.outcomes.protected + f.outcomes.prevented} stopped · tested by {testNamesText(report, f.testKeys)}
                </p>
                {f.guidance?.excerpt ? (
                  <>
                    <p className="rp-guidance">{f.guidance.excerpt}</p>
                    <p className="rp-caption">From the defense guidance of {f.guidance.testName}</p>
                  </>
                ) : f.guidance ? (
                  <p className="rp-caption">See the defense guidance for {f.guidance.testName} in the test library.</p>
                ) : (
                  <p className="rp-caption">No defense guidance is available for the tests that exercised this technique.</p>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      {held.length > 0 && (
        <div className="rp-avoid">
          <h3 className="rp-h3">What held <small>Stage protection rate of 90% or more over at least {HELD_MIN_RESULTS} results</small></h3>
          <div className="rp-grid-2">
            {held.map(({ t, n, rate }) => (
              <div key={t.id} className="rp-card rp-band-held">
                <span><span className="rp-mono">{t.id}</span> {t.name}: <b className="rp-mono">{fmtPct(rate)}</b> ({defended(t.outcomes)} of {n})</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {report.meta.edrVendors.length > 0 && <AlertLatency report={report} />}
      <AcceptedRisks report={report} />
    </Sheet>
  );
}
