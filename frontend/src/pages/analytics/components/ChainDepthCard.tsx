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
  /** Stage rows only: chains blocked here after an earlier EDR alert. */
  alerted: number;
  bundleNames: string[];
  kind: 'stage' | 'detected' | 'undetected';
}

const chainCount = (n: number) => `${n} ${n === 1 ? 'chain' : 'chains'}`;

function rowsOf(data: ChainDepthResponse): Row[] {
  const rows: Row[] = data.buckets.map((b) => ({
    label: b.stage === 4 ? 'Stage 4+' : `Stage ${b.stage}`,
    count: b.blocked,
    alerted: b.alertedNotBlocked,
    bundleNames: b.bundleNames,
    kind: 'stage' as const,
  }));
  // Chains nothing blocked, split by whether an EDR at least alerted: the
  // Defense Score counts a detection as protected, chain depth only a block
  rows.push(
    {
      label: 'End to end · detected',
      count: data.endToEndAlerted,
      alerted: 0,
      bundleNames: data.endToEndAlertedBundleNames,
      kind: 'detected',
    },
    {
      label: 'End to end · undetected',
      count: data.endToEnd - data.endToEndAlerted,
      alerted: 0,
      bundleNames: data.endToEndUndetectedBundleNames,
      kind: 'undetected',
    },
  );
  return rows;
}

function rowName(row: Row): string {
  if (row.count === 0) return `${row.label}: no chains`;
  if (row.kind === 'stage') {
    return `${row.label}: ${chainCount(row.count)} blocked, ${row.alerted} after an earlier EDR alert. Show these runs`;
  }
  const how = row.kind === 'detected' ? 'an EDR alerted' : 'no alert';
  return `${row.label}: ${chainCount(row.count)} ran every stage, ${how}. Show these runs`;
}

const MAIN_COLOR: Record<Row['kind'], string> = {
  stage: 'var(--chart-protected)',
  detected: 'var(--chart-warn)',
  undetected: 'var(--chart-bypassed)',
};

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
  if (data.chains === 0 && data.inconclusive === 0) {
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
                className="grid w-full grid-cols-[148px_minmax(0,1fr)_64px] items-center gap-x-2.5 rounded px-1 py-1 text-left transition-colors enabled:hover:bg-raised disabled:cursor-default"
              >
                <span
                  className={cn(
                    'truncate text-xs',
                    row.kind === 'detected' && 'text-warning',
                    row.kind === 'undetected' && 'text-danger',
                  )}
                >
                  {row.label}
                </span>
                <span className="flex h-2.5 overflow-hidden rounded-sm bg-raised">
                  <span
                    data-segment="main"
                    className="h-full"
                    style={{
                      width: `${((row.count - alerted) / max) * 100}%`,
                      backgroundColor: MAIN_COLOR[row.kind],
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
                    row.count > 0 && row.kind === 'undetected'
                      ? 'text-danger'
                      : row.count > 0 && row.kind === 'detected'
                        ? 'text-warning'
                        : 'text-muted',
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
              EDR alerted, didn't block
            </span>
          </div>
          {data.inconclusive > 0 && (
            <span>
              {`${chainCount(data.inconclusive)} inconclusive — a stage errored or was blocked before it ran — not shown`}
            </span>
          )}
          <span>Follows the filter bar — pick an actor to see how far its chains get. Click a row for those runs.</span>
        </div>
      </CardContent>
    </Frame>
  );
}

export default memo(ChainDepthCard);
