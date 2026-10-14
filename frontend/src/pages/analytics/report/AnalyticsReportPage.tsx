// /analytics/report — print-ready execution report for the All Executions
// filters in the URL (spec §5.4). No app shell; saved to PDF via print.
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { filtersFromSearchParams, toApiParams } from '@/hooks/useAnalyticsFilters';
import { reportsApi, type ExecutionReport } from '@/services/api/reports';
import { MARKINGS, ReportDocument, type Marking, type Paper } from './ReportDocument';
import { readChoice, writeChoice } from './lib/persist';
import './report.css';

const PAPERS: readonly Paper[] = ['A4', 'Letter'];
const PAPER_KEY = 'achilles.report.paper';
const MARKING_KEY = 'achilles.report.marking';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; report: ExecutionReport };

export default function AnalyticsReportPage() {
  const [searchParams] = useSearchParams();
  const query = searchParams.toString();
  // Same serialization as the Executions tab: multi-value filters are comma-joined strings,
  // because the report route answers 400 to repeated or array query params.
  const params = useMemo(() => toApiParams(filtersFromSearchParams(new URLSearchParams(query))), [query]);
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [paper, setPaper] = useState<Paper>(() => readChoice(PAPER_KEY, 'A4', PAPERS));
  const [marking, setMarking] = useState<Marking>(() => readChoice(MARKING_KEY, 'TLP:AMBER', MARKINGS));

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    reportsApi.getExecutionReport({ ...params, tz }).then(
      (report) => { if (!cancelled) setState({ status: 'ready', report }); },
      (err: unknown) => {
        // The message only: apiClient already replaces it with the backend's error text.
        if (!cancelled) setState({ status: 'error', message: err instanceof Error ? err.message : 'The report could not be built.' });
      },
    );
    return () => { cancelled = true; };
  }, [params, tz, attempt]);

  useEffect(() => {
    const previous = document.title;
    document.title = state.status === 'ready' ? `Execution report ${state.report.meta.reportId}` : 'Execution report';
    return () => { document.title = previous; };
  }, [state]);

  const backParams = new URLSearchParams(query);
  backParams.set('tab', 'executions');
  const backHref = `/analytics?${backParams.toString()}`;

  return (
    <div className="report-print">
      <div className="rp-toolbar" role="toolbar" aria-label="Report actions">
        <div className="rp-toolbar-group">
          <Link className="rp-btn rp-btn-ghost" to={backHref}>Back to analytics</Link>
          <span className="rp-hint">
            Save as PDF from the print dialog. The marking on each page, the running headers and the page numbers print
            in Chromium-based browsers (Chrome, Edge); other browsers omit them.
          </span>
        </div>
        <div className="rp-toolbar-group">
          <label htmlFor="rp-paper">Paper</label>
          <select
            id="rp-paper"
            value={paper}
            onChange={(e) => { const v = e.target.value as Paper; setPaper(v); writeChoice(PAPER_KEY, v); }}
          >
            {PAPERS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <label htmlFor="rp-marking">Marking</label>
          <select
            id="rp-marking"
            value={marking}
            onChange={(e) => { const v = e.target.value as Marking; setMarking(v); writeChoice(MARKING_KEY, v); }}
          >
            {MARKINGS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <button type="button" className="rp-btn" onClick={() => window.print()} disabled={state.status !== 'ready'}>
            Print / Save as PDF
          </button>
        </div>
      </div>
      {state.status === 'loading' && <div className="rp-state"><p className="rp-muted" role="status">Building report…</p></div>}
      {state.status === 'error' && (
        <div className="rp-state">
          <div className="rp-banner" role="alert">{state.message}</div>
          <button type="button" className="rp-btn" onClick={() => setAttempt((a) => a + 1)}>Retry</button>
        </div>
      )}
      {state.status === 'ready' && <ReportDocument report={state.report} paper={paper} marking={marking} />}
    </div>
  );
}
