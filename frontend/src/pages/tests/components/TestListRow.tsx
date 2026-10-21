import { Heart, Play } from 'lucide-react';
import type { TestMetadata } from '@/types/test';
import { Checkbox } from '@/components/ui/checkbox';
import { targetLabel } from '@/utils/platformLabels';
import { cn } from '@/lib/utils';
import type { FleetResult } from './fleetResult';

/*
 * Library list grid (board A). From `lg` up every column shows; below it the
 * techniques/platform/stages/score cells hide and the fleet result stacks under
 * the name so a 375px row keeps most of its width for the name.
 */
const ROW_GRID =
  'grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 px-3 lg:grid-cols-[minmax(0,1fr)_210px_150px_64px_190px_56px_76px] lg:gap-4 lg:px-4';

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent';

const VISIBLE_TECHNIQUES = 2;

interface TestListRowProps {
  test: TestMetadata;
  fleet: FleetResult;
  onOpen: () => void;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  onExecute?: () => void;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
}

function actorLine(test: TestMetadata): string {
  const actor = test.threatActor?.trim() || 'No attributed actor';
  const sub = test.subcategory?.trim();
  return sub ? `${actor} · ${sub}` : actor;
}

/** Column labels for a group's list; hidden below `lg`, where the row stacks. */
export function TestListHeader() {
  return (
    <div
      className={cn(
        ROW_GRID,
        'hidden border-b border-border py-2.5 text-[11px] uppercase tracking-wider text-faint lg:grid',
      )}
    >
      <span>Test</span>
      <span>Techniques</span>
      <span>Platform</span>
      <span>Stages</span>
      <span>Fleet result</span>
      <span>Score</span>
      <span />
    </div>
  );
}

export function TestListRow({
  test,
  fleet,
  onOpen,
  isFavorite,
  onToggleFavorite,
  onExecute,
  selectMode,
  selected,
  onToggleSelect,
}: TestListRowProps) {
  const primary = selectMode ? onToggleSelect : onOpen;
  const stageCount = test.stageCount ?? test.stages.length;
  const extraTechniques = test.techniques.length - VISIBLE_TECHNIQUES;
  const platforms = test.target?.length ? test.target.map(targetLabel).join(', ') : '—';

  return (
    <li
      onClick={primary}
      className={cn(
        ROW_GRID,
        'group cursor-pointer items-center border-b border-border py-3 transition-colors last:border-b-0 hover:bg-raised',
        selected && 'bg-accent-dim/40 hover:bg-accent-dim/60',
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {selectMode && (
          <Checkbox
            checked={selected}
            onCheckedChange={onToggleSelect}
            onClick={(e) => e.stopPropagation()}
            className="mt-0.5"
            aria-label={`Select ${test.name}`}
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <button
            type="button"
            title={test.name}
            onClick={(e) => {
              e.stopPropagation();
              primary();
            }}
            className={cn(
              'block min-w-0 max-w-full truncate rounded-sm text-left text-[13.5px] font-semibold text-foreground hover:text-accent',
              FOCUS_RING,
            )}
          >
            {test.name}
          </button>
          <span className="truncate text-xs text-muted">{actorLine(test)}</span>
        </div>
      </div>

      <div className="hidden flex-wrap items-center gap-1 lg:flex">
        {test.techniques.slice(0, VISIBLE_TECHNIQUES).map((technique) => (
          <span key={technique} className="rounded bg-overlay px-1.5 py-px font-mono text-[11px] text-muted">
            {technique}
          </span>
        ))}
        {extraTechniques > 0 && <span className="text-[11px] text-faint">+{extraTechniques}</span>}
      </div>

      <span className="hidden truncate text-xs text-muted lg:block" title={platforms}>
        {platforms}
      </span>

      <span className="hidden font-mono text-xs text-muted lg:block">
        {stageCount > 0 ? stageCount : '—'}
      </span>

      <div
        title={fleet.title}
        className="flex min-w-0 flex-col gap-1 max-lg:col-start-1 max-lg:row-start-2"
      >
        {fleet.share != null && (
          <div className="flex h-1.5 w-full max-w-[120px] overflow-hidden rounded-full bg-danger-dim">
            <div
              data-testid="fleet-bar"
              className="bg-accent"
              style={{ width: `${Math.round(fleet.share * 100)}%` }}
            />
          </div>
        )}
        <span
          data-fleet-text
          className={cn('text-xs', fleet.share != null ? 'text-foreground' : 'text-faint')}
        >
          {fleet.text}
        </span>
      </div>

      <span className="hidden font-mono text-xs text-muted lg:block">
        {test.score != null ? test.score.toFixed(1) : '—'}
      </span>

      <div
        className={cn(
          'flex items-center justify-end gap-1.5 opacity-40 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100',
          'max-lg:col-start-2 max-lg:row-span-2 max-lg:row-start-1',
        )}
      >
        {!selectMode && (
          <>
            <button
              type="button"
              aria-label={isFavorite ? `Remove ${test.name} from favorites` : `Add ${test.name} to favorites`}
              aria-pressed={isFavorite}
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite();
              }}
              className={cn(
                'inline-flex size-[30px] items-center justify-center rounded-md hover:bg-overlay',
                isFavorite ? 'text-danger' : 'text-muted hover:text-foreground',
                FOCUS_RING,
              )}
            >
              <Heart className={cn('h-[15px] w-[15px]', isFavorite && 'fill-current')} aria-hidden="true" />
            </button>
            {onExecute && (
              <button
                type="button"
                aria-label={`Run ${test.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onExecute();
                }}
                className={cn(
                  'inline-flex size-[30px] items-center justify-center rounded-md border border-accent/40 bg-accent-dim text-accent hover:bg-accent-dim/70',
                  FOCUS_RING,
                )}
              >
                <Play className="h-[13px] w-[13px]" aria-hidden="true" />
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
}
