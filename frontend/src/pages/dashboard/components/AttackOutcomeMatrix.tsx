import { Link } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { AttackMatrixView, CellState, MatrixColumn } from '../dashboardViews';

interface AttackOutcomeMatrixProps {
  view: AttackMatrixView | null;
  loading?: boolean;
}

const STATE_META: Record<CellState, { word: string; cell: string }> = {
  through: { word: 'got through', cell: 'bg-danger' },
  detected: { word: 'EDR alert, not blocked', cell: 'bg-warning' },
  protected: { word: 'protected', cell: 'bg-accent' },
  notRun: { word: 'not run in window', cell: 'bg-overlay ring-1 ring-inset ring-border-strong' },
};

function ruleClass(col: MatrixColumn): string {
  if (col.throughCount >= 3) return 'border-danger';
  if (col.throughCount > 0) return 'border-warning';
  return 'border-accent';
}

function Chip({ className, children }: { className: string; children: string }) {
  return <span className={cn('rounded-md px-2 py-1 font-mono text-[11px]', className)}>{children}</span>;
}

export function AttackOutcomeMatrix({ view, loading }: AttackOutcomeMatrixProps) {
  if (loading || !view) {
    return <div className="h-72 animate-pulse rounded-lg border border-border bg-raised" aria-hidden="true" />;
  }

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0 grid-rows-1">
        <div className="flex flex-col gap-1">
          <CardTitle>MITRE ATT&amp;CK coverage</CardTitle>
          <CardDescription>Each cell is a technique, coloured by its latest result per stage</CardDescription>
        </div>
        {!view.empty && (
          <div className="flex flex-wrap gap-1.5">
            <Chip className="bg-accent-dim text-accent">{`${view.totals.protected} protected`}</Chip>
            <Chip className="bg-danger-dim text-danger">{`${view.totals.through} got through`}</Chip>
            <Chip className="bg-warning-dim text-warning">{`${view.totals.detected} detected only`}</Chip>
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
                const protectedN = col.cells.filter((c) => c.state === 'protected').length;
                const tested = col.cells.filter((c) => c.state !== 'notRun').length;
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
                        {tested > 0 ? `${protectedN}/${tested}` : '—'}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-[3px]">
                      {col.cells.map((cell) => {
                        const meta = STATE_META[cell.state];
                        const label = `${cell.technique} · ${meta.word}`;
                        return (
                          <Link
                            key={cell.technique}
                            to={`/analytics?techniques=${encodeURIComponent(cell.technique)}`}
                            aria-label={label}
                            title={`${col.name} · ${label}`}
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
                {(['protected', 'through', 'detected', 'notRun'] as const).map((s) => (
                  <span key={s} className="inline-flex items-center gap-1.5">
                    <span className={cn('size-2.5 rounded-sm', STATE_META[s].cell)} />
                    {s === 'notRun' ? 'in library, not run' : STATE_META[s].word}
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
