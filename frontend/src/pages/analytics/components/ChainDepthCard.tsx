import { memo } from 'react';
import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { ChainDepthResponse } from '@/services/api/analytics';

interface ChainDepthCardProps {
  /** null after a failed fetch. */
  data: ChainDepthResponse | null;
  loading?: boolean;
  /** Row click: the bundle names of the chains in that row. */
  onRowClick?: (bundleNames: string[]) => void;
}

const TITLE = 'How deep attack chains get';
const DESCRIPTION = "Stage where each chain's latest run was blocked";

interface Row {
  label: string;
  count: number;
  alerted: number;
  bundleNames: string[];
  endToEnd: boolean;
}

const chainCount = (n: number) => `${n} ${n === 1 ? 'chain' : 'chains'}`;

function rowsOf(data: ChainDepthResponse): Row[] {
  const rows: Row[] = data.buckets.map((b) => ({
    label: b.stage === 4 ? 'Stage 4+' : `Stage ${b.stage}`,
    count: b.blocked,
    alerted: b.alertedNotBlocked,
    bundleNames: b.bundleNames,
    endToEnd: false,
  }));
  rows.push({
    label: 'Ran end to end',
    count: data.endToEnd,
    alerted: data.endToEndAlerted,
    bundleNames: data.endToEndBundleNames,
    endToEnd: true,
  });
  return rows;
}

function rowName(row: Row): string {
  const alerted = row.endToEnd
    ? `${row.alerted} with an EDR alert`
    : `${row.alerted} after an earlier EDR alert`;
  const counted = row.endToEnd ? chainCount(row.count) : `${chainCount(row.count)} blocked`;
  return row.count > 0 ? `${row.label}: ${counted}, ${alerted}. Show these runs` : `${row.label}: no chains`;
}

function Frame({ chip, children }: { chip?: string; children: ReactNode }) {
  return (
    <Card className="h-full">
      <CardHeader className="grid-cols-[1fr_auto]">
        <CardTitle>{TITLE}</CardTitle>
        <CardDescription className="col-start-1">{DESCRIPTION}</CardDescription>
        {chip && (
          <span className="col-start-2 row-span-2 row-start-1 w-fit shrink-0 self-start rounded-md bg-raised px-2 py-1 font-mono text-[11px] text-muted">
            {chip}
          </span>
        )}
      </CardHeader>
      {children}
    </Card>
  );
}

function ChainDepthCard({ data, loading, onRowClick }: ChainDepthCardProps) {
  if (loading) {
    return <div className="h-72 animate-pulse rounded-lg border border-border bg-raised" aria-hidden="true" />;
  }
  if (!data) {
    return (
      <Frame>
        <CardContent className="flex h-40 items-center justify-center text-sm text-faint">
          Couldn't load chain depth
        </CardContent>
      </Frame>
    );
  }
  if (data.chains === 0) {
    return (
      <Frame>
        <CardContent className="flex h-40 items-center justify-center text-sm text-faint">
          No multi-stage chains in this window
        </CardContent>
      </Frame>
    );
  }

  const rows = rowsOf(data);
  const max = Math.max(1, ...rows.map((r) => r.count));

  return (
    <Frame chip={chainCount(data.chains)}>
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          {rows.map((row) => {
            const alerted = Math.min(row.alerted, row.count);
            return (
              <button
                key={row.label}
                type="button"
                disabled={row.count === 0}
                onClick={() => onRowClick?.(row.bundleNames)}
                aria-label={rowName(row)}
                title={row.bundleNames.length > 0 ? row.bundleNames.join(', ') : undefined}
                className="grid w-full grid-cols-[92px_minmax(0,1fr)_64px] items-center gap-x-2.5 rounded px-1 py-1 text-left transition-colors enabled:hover:bg-raised disabled:cursor-default"
              >
                <span className={cn('truncate text-xs', row.endToEnd && 'text-danger')}>{row.label}</span>
                <span className="flex h-2.5 overflow-hidden rounded-sm bg-raised">
                  <span
                    data-segment="main"
                    className="h-full"
                    style={{
                      width: `${((row.count - alerted) / max) * 100}%`,
                      backgroundColor: row.endToEnd ? 'var(--chart-bypassed)' : 'var(--chart-protected)',
                    }}
                  />
                  <span
                    data-segment="alerted"
                    className="h-full"
                    style={{ width: `${(alerted / max) * 100}%`, backgroundColor: 'var(--chart-warn)' }}
                  />
                </span>
                <span
                  className={cn(
                    'text-right font-mono text-[11px]',
                    row.endToEnd && row.count > 0 ? 'text-danger' : 'text-muted',
                  )}
                >
                  {chainCount(row.count)}
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-auto flex flex-col gap-1.5 border-t border-border pt-2.5 text-xs text-muted">
          <div className="flex flex-wrap gap-x-3.5 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <span
                className="h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: 'var(--chart-protected)' }}
                aria-hidden="true"
              />
              blocked at this stage
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: 'var(--chart-warn)' }}
                aria-hidden="true"
              />
              EDR alerted earlier, didn't block
            </span>
          </div>
          <span>Follows the filter bar — pick an actor to see how far its chains get. Click a row for those runs.</span>
        </div>
      </CardContent>
    </Frame>
  );
}

export default memo(ChainDepthCard);
