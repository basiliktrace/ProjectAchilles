import { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Download, Printer } from 'lucide-react';
import { PageContainer, PageHeader } from '@/components/endpoints/Layout';
import { Button } from '@/components/shared/ui/Button';
import { Alert } from '@/components/shared/ui/Alert';
import { Spinner } from '@/components/shared/ui/Spinner';
import { campaignsApi, type CellState, type RunMatrix } from '@/services/api/campaigns';

const POLL_MS = 15_000;

const STATE_ORDER: CellState[] = [
  'protected', 'unprotected', 'error', 'running', 'waiting_for_notice', 'not_run', 'na',
];

const STATE_LABEL: Record<CellState, string> = {
  waiting_for_notice: 'Waiting for notice',
  running: 'Running',
  protected: 'Protected',
  unprotected: 'Unprotected',
  error: 'Error',
  not_run: 'Not run',
  na: 'N/A',
};

/** Theme tokens only, so all three themes restyle the matrix. */
const STATE_CLASS: Record<CellState, string> = {
  waiting_for_notice: 'bg-info-dim text-info',
  running: 'bg-info-dim text-info',
  protected: 'bg-success/15 text-success',
  unprotected: 'bg-danger-dim text-danger',
  error: 'bg-warning-dim text-warning',
  not_run: 'bg-raised text-muted',
  na: 'bg-raised text-faint',
};

const TERMINAL: CellState[] = ['protected', 'unprotected', 'error', 'not_run'];

function isUnsettled(m: RunMatrix): boolean {
  return m.totals.waiting_for_notice > 0 || m.totals.running > 0;
}

function progressPercent(m: RunMatrix): number {
  const t = m.totals;
  const applicable = STATE_ORDER.filter((s) => s !== 'na').reduce((n, s) => n + t[s], 0);
  if (applicable === 0) return 100;
  const done = TERMINAL.reduce((n, s) => n + t[s], 0);
  return Math.round((done / applicable) * 100);
}

const NOTICE_STATE_LABEL: Record<string, string> = {
  pending: 'pending',
  sent: 'sent',
  not_delivered: 'not delivered',
  overridden: 'overridden',
  skipped: 'skipped',
};

export default function CampaignRunPage() {
  const { runId } = useParams<{ runId: string }>();
  const [matrix, setMatrix] = useState<RunMatrix | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    if (!runId) return;
    try {
      setMatrix(await campaignsApi.getRun(runId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load run');
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  const unsettled = matrix !== null && isUnsettled(matrix);
  useEffect(() => {
    if (!unsettled) return;
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [unsettled, load]);

  async function downloadCsv() {
    if (!runId || exporting) return;
    setExporting(true);
    try {
      const { blob, filename } = await campaignsApi.exportRunCsv(runId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename ?? `campaign-run-${runId}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to export CSV');
    } finally {
      setExporting(false);
    }
  }

  if (!matrix) {
    return (
      <PageContainer>
        {error ? <Alert variant="destructive">{error}</Alert> : <div className="flex justify-center py-12"><Spinner /></div>}
      </PageContainer>
    );
  }

  const { run, tests, agents, cells, totals } = matrix;
  const percent = progressPercent(matrix);
  const notice = run.notice;

  return (
    <PageContainer>
      <div className="campaign-run-print">
        <PageHeader
          title={run.campaign_name}
          description={run.framework_label ?? undefined}
          actions={(
            <div className="flex items-center gap-2 print:hidden">
              <Button variant="outline" onClick={() => window.print()}>
                <Printer className="w-4 h-4 mr-2" />Print
              </Button>
              <Button variant="outline" onClick={() => void downloadCsv()} disabled={exporting}>
                <Download className="w-4 h-4 mr-2" />Download CSV
              </Button>
            </div>
          )}
        />

        {error && <Alert variant="destructive" className="mb-4">{error}</Alert>}

        <dl className="mb-4 grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
          <div><dt className="inline text-muted">Started by </dt><dd className="inline">{run.started_by}</dd></div>
          <div><dt className="inline text-muted">Started </dt><dd className="inline">{new Date(run.started_at).toLocaleString()}</dd></div>
          <div>
            <dt className="inline text-muted">Notice </dt>
            <dd className="inline">
              {notice ? `${notice.run_tag} · ${NOTICE_STATE_LABEL[notice.state] ?? notice.state}` : 'none'}
            </dd>
          </div>
          <div><dd className="inline font-medium">{`As of ${new Date(matrix.as_of).toLocaleString()}`}</dd></div>
        </dl>

        <div className="mb-4">
          <div className="mb-1 flex justify-between text-sm">
            <span className="text-muted">Progress</span>
            <span>{`${percent}%`}</span>
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-2 overflow-hidden rounded bg-raised"
          >
            <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
          </div>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <div>
            <span className="text-muted">Protected </span>
            <span data-testid="percent-protected" className="text-lg font-semibold">
              {totals.percent_protected === null ? '—' : `${totals.percent_protected}%`}
            </span>
          </div>
          {STATE_ORDER.map((s) => (
            <span key={s} className="text-muted">
              {`${STATE_LABEL[s]}: `}<span className="text-foreground">{totals[s]}</span>
            </span>
          ))}
        </div>

        <div className="campaign-matrix-scroll overflow-x-auto rounded-[10px] border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-surface">
                <th className="px-3 py-2 text-left font-medium">Test</th>
                {agents.map((a) => (
                  <th key={a.id} className="px-3 py-2 text-left font-medium">
                    {a.hostname}
                    <span className="block text-xs font-normal text-muted">{a.os}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tests.map((t) => (
                <tr key={t.uuid} className="border-t border-border">
                  <th scope="row" className="px-3 py-2 text-left font-normal">{t.name}</th>
                  {agents.map((a) => {
                    const c = cells[t.uuid]?.[a.id];
                    if (!c) return <td key={a.id} className="px-3 py-2" />;
                    const title = (c.state === 'na' || c.state === 'not_run') && c.reason ? c.reason : undefined;
                    return (
                      <td key={a.id} data-state={c.state} title={title} className={`px-3 py-2 ${STATE_CLASS[c.state]}`}>
                        {STATE_LABEL[c.state]}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-sm print:hidden">
          <Link to="/campaigns" className="text-accent hover:underline">Back to campaigns</Link>
        </p>
      </div>
    </PageContainer>
  );
}
