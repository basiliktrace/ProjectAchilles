import { Link } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { AttackMatrixView, CellState, MatrixColumn } from '../dashboardViews';
import { AnalyticsSetupPrompt } from './AnalyticsSetupPrompt';

interface AttackOutcomeMatrixProps {
  view: AttackMatrixView | null;
  /** Analytics (Elasticsearch) is configured; false shows a setup prompt. */
  configured: boolean;
  /** Window label shown in the description, e.g. "30d". */
  rangeLabel?: string;
  loading?: boolean;
}

const STATE_META: Record<CellState, { legend: string; cell: string }> = {
  stopped: { legend: 'stopped (≥95%)', cell: 'bg-accent' },
  partial: { legend: 'partial (80–94%)', cell: 'bg-warning' },
  through: { legend: 'got through (<80%)', cell: 'bg-danger' },
  notRun: { legend: 'in library, not run', cell: 'bg-overlay ring-1 ring-inset ring-border-strong' },
};

function ruleClass(col: MatrixColumn): string {
  if (col.throughCount >= 3) return 'border-danger';
  if (col.throughCount > 0) return 'border-warning';
  return 'border-accent';
}

function Chip({ className, children }: { className: string; children: string }) {
  return <span className={cn('rounded-md px-2 py-1 font-mono text-[11px]', className)}>{children}</span>;
}

export function AttackOutcomeMatrix({ view, configured, rangeLabel, loading }: AttackOutcomeMatrixProps) {
  if (loading) {
    return <div className="h-72 animate-pulse rounded-lg border border-border bg-raised" aria-hidden="true" />;
  }
  if (!configured || !view) {
    return (
      <Card className="h-full">
        <CardHeader>
          <CardTitle>MITRE ATT&amp;CK coverage</CardTitle>
          <CardDescription>Each cell is a technique, coloured by the share of its test × endpoint results that were stopped</CardDescription>
        </CardHeader>
        {!configured ? (
          <CardContent>
            <AnalyticsSetupPrompt subject="ATT&amp;CK outcomes" />
          </CardContent>
        ) : (
          <CardContent className="flex h-40 items-center justify-center text-sm text-faint">
            Couldn't load ATT&amp;CK outcomes — try again later
          </CardContent>
        )}
      </Card>
    );
  }

  return (
    <Card className="h-full">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0 grid-rows-1">
        <div className="flex flex-col gap-1">
          <CardTitle>MITRE ATT&amp;CK coverage</CardTitle>
          <CardDescription>Each cell is a technique, coloured by the share of its test × endpoint results that were stopped{rangeLabel ? ` · ${rangeLabel}` : ''}</CardDescription>
        </div>
        {!view.empty && (
          <div className="flex flex-wrap gap-1.5">
            <Chip className="bg-accent-dim text-accent">{`${view.totals.stopped} stopped`}</Chip>
            <Chip className="bg-warning-dim text-warning">{`${view.totals.partial} partial`}</Chip>
            <Chip className="bg-danger-dim text-danger">{`${view.totals.through} got through`}</Chip>
            <Chip className="bg-raised text-muted">{`${view.totals.notRun} not run`}</Chip>
          </div>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3.5">
        {view.empty ? (
          <div className="flex h-40 items-center justify-center text-sm text-faint">
            No ATT&amp;CK-mapped tests yet
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-12">
              {view.columns.map((col) => {
                return (
                  <div key={col.slug} className="flex min-w-0 flex-col gap-1.5">
                    <div
                      className={cn('flex flex-col items-center gap-px border-b-2 pb-1.5', ruleClass(col))}
                      title={col.name}
                    >
                      <span className="font-mono text-[11.5px] font-medium">{col.code}</span>
                      <span
                        className={cn('font-mono text-[10px]', col.throughCount > 0 ? 'text-danger' : 'text-muted')}
                      >
                        {col.testedCount > 0 ? `${col.stoppedCount}/${col.testedCount}` : '—'}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-[3px]">
                      {col.cells.map((cell) => {
                        const meta = STATE_META[cell.state];
                        const label = cell.label;
                        return (
                          <Link
                            key={cell.technique}
                            to={`/analytics?techniques=${encodeURIComponent(cell.technique)}`}
                            aria-label={label}
                            title={label}
                            className={cn('h-3.5 rounded-[3px] hover:opacity-70', meta.cell)}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-border pt-2.5 text-xs text-muted">
              <div className="flex flex-wrap gap-x-3.5 gap-y-1">
                {(['stopped', 'partial', 'through', 'notRun'] as const).map((s) => (
                  <span key={s} className="inline-flex items-center gap-1.5">
                    <span aria-hidden="true" className={cn('size-2.5 rounded-sm', STATE_META[s].cell)} />
                    {STATE_META[s].legend}
                  </span>
                ))}
              </div>
              <span>
                {view.weakestTactic && (
                  <>
                    Weakest:{' '}
                    <span className="text-danger">
                      {`${view.weakestTactic.name} (${view.weakestTactic.throughCount} got through)`}
                    </span>
                    {' · '}
                  </>
                )}
                click a cell to open the technique
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
