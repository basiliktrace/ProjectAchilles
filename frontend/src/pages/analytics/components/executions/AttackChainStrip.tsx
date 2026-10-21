import type { EnrichedTestExecution } from '@/services/api/analytics';
import { cn } from '@/lib/utils';
import { stageNumber, stageTechnique, stageTone } from './stageDisplay';

interface AttackChainStripProps {
  /** Bundle members in stage order (the backend sorts them). */
  stages: EnrichedTestExecution[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
}

/**
 * The run's stages as connected nodes, coloured by outcome. Each node is a
 * button that selects the same stage row below it. Narrow panels scroll the
 * strip inside its own box rather than the page.
 */
export function AttackChainStrip({ stages, selectedIndex, onSelect }: AttackChainStripProps) {
  return (
    <div className="-mx-1 overflow-x-auto px-1 pb-1">
      <ol
        aria-label="Attack chain"
        className="grid auto-cols-[minmax(6.5rem,1fr)] grid-flow-col"
      >
        {stages.map((exec, index) => {
          const n = stageNumber(exec, index);
          const tone = stageTone(exec);
          const technique = stageTechnique(exec);
          const selected = selectedIndex === index;
          return (
            <li key={`${exec.test_uuid}::${index}`} className="flex">
              <button
                type="button"
                onClick={() => onSelect(index)}
                aria-label={`Stage ${n}, ${exec.test_name}: ${tone.label}`}
                aria-current={selected ? 'step' : undefined}
                className={cn(
                  'flex min-h-11 w-full flex-col items-center gap-0.5 rounded-md px-0 pb-2.5 pt-1 text-center transition-colors hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                  selected && 'bg-raised',
                )}
              >
                <span className="flex w-full items-center" aria-hidden="true">
                  <span className={cn('h-0.5 flex-1', index > 0 ? 'bg-border-strong' : 'bg-transparent')} />
                  <span
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-current font-mono text-[13px] font-medium',
                      tone.text,
                      tone.dim,
                      selected && 'ring-2 ring-current ring-offset-2 ring-offset-surface',
                    )}
                  >
                    {n}
                  </span>
                  <span
                    className={cn('h-0.5 flex-1', index < stages.length - 1 ? 'bg-border-strong' : 'bg-transparent')}
                  />
                </span>
                {technique && <span className="mt-2 font-mono text-xs text-foreground">{technique.id}</span>}
                <span className="line-clamp-2 px-1.5 text-xs leading-snug text-muted">{exec.test_name}</span>
                <span className={cn('mt-1 text-xs font-medium', tone.text)}>{tone.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
