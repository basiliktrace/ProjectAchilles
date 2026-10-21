import { memo } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { EnrichedTestExecution } from '@/services/api/analytics';
import { FitList } from '@/components/shared/FitList';
import { cn } from '@/lib/utils';

interface TestActivityCardProps {
  /** Recent executions, newest first. */
  recentTests: EnrichedTestExecution[];
  /** Total executions in the window (pagination total, not a pair count). */
  executionCount?: number | null;
  loading?: boolean;
  title?: string;
  className?: string;
}

// Parse timestamp - handles both epoch ms strings and ISO strings
function parseTimestamp(timestamp: string): Date {
  if (!timestamp) return new Date(NaN);
  if (/^\d+$/.test(timestamp)) {
    return new Date(parseInt(timestamp, 10));
  }
  return new Date(timestamp);
}

function isValidDate(date: Date): boolean {
  return date instanceof Date && !isNaN(date.getTime());
}

function getRelativeTime(timestamp: string): string {
  const date = parseTimestamp(timestamp);
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMinutes < 1) return 'now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return `${Math.floor(diffDays / 7)}w ago`;
}

function TestActivityCard({
  recentTests,
  executionCount,
  loading,
  title = 'Test activity',
  className,
}: TestActivityCardProps) {
  if (loading) {
    return <div className="h-72 animate-pulse rounded-lg border border-border bg-raised" aria-hidden="true" />;
  }

  // Most recent execution by timestamp (do not rely on list order).
  const latest = recentTests.reduce<Date | null>((best, t) => {
    const d = parseTimestamp(t.timestamp);
    if (!isValidDate(d)) return best;
    return best === null || d > best ? d : best;
  }, null);

  const description =
    latest && executionCount != null
      ? `${executionCount.toLocaleString()} tests · last run ${latest.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`
      : 'Latest executions in window';

  return (
    <Card className={cn('h-full', className)}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        {recentTests.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-faint">
            Nothing recorded yet.
          </div>
        ) : (
          <FitList
            items={recentTests}
            min={3}
            max={12}
            fallback={4}
            gap={8}
            getKey={(execution, index) => `${execution.test_uuid}-${execution.timestamp}-${index}`}
          >
            {(execution) => (
              <div className="flex items-center gap-2.5 rounded-md border border-border bg-raised px-3 py-2.5 text-xs">
                <span className="min-w-0 flex-1 truncate" title={execution.test_name}>
                  {execution.test_name || 'Unknown Test'}
                </span>
                {execution.is_protected ? (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-accent" />
                ) : (
                  <XCircle className="h-3.5 w-3.5 shrink-0 text-danger" />
                )}
                <span className="shrink-0 whitespace-nowrap text-faint">
                  {getRelativeTime(execution.timestamp)}
                </span>
              </div>
            )}
          </FitList>
        )}
      </CardContent>
    </Card>
  );
}

export default memo(TestActivityCard);
