import { Link } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { ActorReadinessView, ActorRow } from '../dashboardViews';

interface ThreatActorReadinessCardProps {
  view: ActorReadinessView | null;
  loading?: boolean;
}

const STALE_DAYS = 14;

function daysAgo(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

function scoreClass(score: number): string {
  if (score < 80) return 'text-danger';
  if (score < 95) return 'text-warning';
  return 'text-accent';
}

function ActorLine({ row }: { row: ActorRow }) {
  const ago = daysAgo(row.lastTestedAt);
  const stale = ago != null && ago > STALE_DAYS;
  const score = Math.min(100, Math.max(0, row.score));
  const meta = `${row.testCount} ${row.testCount === 1 ? 'test' : 'tests'}${ago != null ? ` · ${ago}d ago` : ''}`;
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)_2.75rem] items-center gap-x-3 py-1.5 max-sm:grid-cols-[6rem_minmax(0,1fr)_2.75rem]">
      <div className="flex min-w-0 flex-col gap-px">
        <span className="truncate text-[13px] font-medium" title={row.threatActor}>{row.threatActor}</span>
        <span className={cn('font-mono text-[10.5px]', stale ? 'text-warning' : 'text-muted')}>{meta}</span>
      </div>
      <div
        role="img"
        aria-label={`${row.threatActor}: ${Math.round(score)}% protected across ${row.pairCount} test-endpoint pairs`}
        className="flex h-2 overflow-hidden rounded bg-border"
      >
        <div className="bg-accent" style={{ width: `${score}%` }} />
        <div className="bg-danger" style={{ width: `${100 - score}%` }} />
      </div>
      <span className={cn('text-right font-mono text-xs', scoreClass(row.score))}>{Math.round(row.score)}%</span>
    </div>
  );
}

export function ThreatActorReadinessCard({ view, loading }: ThreatActorReadinessCardProps) {
  if (loading || !view) {
    return <div className="h-72 animate-pulse rounded-lg border border-border bg-raised" aria-hidden="true" />;
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 grid-rows-1">
        <div className="flex flex-col gap-1">
          <CardTitle>Threat actor readiness</CardTitle>
          <CardDescription>Which adversaries would get through today · worst first</CardDescription>
        </div>
        {view.exposedCount > 0 && (
          <span className="shrink-0 rounded-md bg-danger-dim px-2 py-1 font-mono text-[11px] text-danger">
            {view.exposedCount} exposed
          </span>
        )}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        {view.empty ? (
          <div className="flex h-40 items-center justify-center text-sm text-faint">
            No threat-actor tests in the library
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-0.5">
              {view.rows.map((row) => (
                <ActorLine key={row.threatActor} row={row} />
              ))}
              {view.rows.length === 0 && (
                <div className="py-6 text-center text-sm text-faint">No threat actor has results in this range</div>
              )}
            </div>
            <div className="mt-auto flex items-center justify-between gap-2.5 border-t border-border pt-2.5 text-xs text-muted">
              <span className="min-w-0">
                {view.untestedActors.length > 0 ? (
                  <>
                    Not tested in {view.rangeLabel.replace(/^the /, '')}:{' '}
                    <span className="text-warning">{view.untestedActors.join(', ')}</span>
                  </>
                ) : (
                  'Every library actor has been tested'
                )}
              </span>
              <Link to="/tests" className="shrink-0 text-[12.5px] text-accent hover:underline">
                Run →
              </Link>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
