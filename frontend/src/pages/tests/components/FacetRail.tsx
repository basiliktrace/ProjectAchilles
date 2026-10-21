import { Switch } from '@/components/ui/switch';
import { targetLabel } from '@/utils/platformLabels';
import { cn } from '@/lib/utils';
import type { FacetCounts, TestFilters, ViewFilter } from '../filterTests';

interface FacetRailProps {
  counts: FacetCounts;
  filters: TestFilters;
  showNotRunYet: boolean;
  showHasBinary: boolean;
  onChange: (patch: Partial<TestFilters>) => void;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pb-1.5 text-[10px] uppercase tracking-wider text-faint">{children}</div>
  );
}

function FacetRow({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex min-h-10 w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent lg:min-h-0',
        active
          ? 'bg-accent-dim text-accent'
          : 'text-muted hover:bg-raised/50 hover:text-foreground',
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate">{label}</span>
      </span>
      {count != null && <span className="font-mono text-[10px] text-faint">{count}</span>}
    </button>
  );
}

const VIEWS: Array<{ value: ViewFilter; label: string }> = [
  { value: 'all', label: 'All tests' },
  { value: 'favorites', label: 'Favorites' },
  { value: 'recent', label: 'Recently viewed' },
];

export function FacetRail({ counts, filters, showNotRunYet, showHasBinary, onChange }: FacetRailProps) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <SectionLabel>View</SectionLabel>
        {VIEWS.map((view) => (
          <FacetRow
            key={view.value}
            label={view.label}
            count={view.value === 'all' ? counts.total : undefined}
            active={filters.view === view.value}
            onClick={() => onChange({ view: view.value })}
          />
        ))}
      </div>

      <div>
        <SectionLabel>Category</SectionLabel>
        <FacetRow
          label="All categories"
          active={filters.category === null}
          onClick={() => onChange({ category: null })}
        />
        {counts.categories.map((c) => (
          <FacetRow
            key={c.value}
            label={c.value}
            count={c.count}
            active={filters.category === c.value}
            onClick={() => onChange({ category: filters.category === c.value ? null : c.value })}
          />
        ))}
      </div>

      {counts.targets.length > 0 && (
        <div>
          <SectionLabel>Platform</SectionLabel>
          {counts.targets.map((t) => (
            <FacetRow
              key={t.value}
              label={targetLabel(t.value)}
              count={t.count}
              active={filters.target === t.value}
              onClick={() => onChange({ target: filters.target === t.value ? null : t.value })}
            />
          ))}
        </div>
      )}

      {counts.threatActors.length > 0 && (
        <div>
          <SectionLabel>Threat actor</SectionLabel>
          {counts.threatActors.map((a) => (
            <FacetRow
              key={a.value}
              label={a.value}
              count={a.count}
              active={filters.threatActor === a.value}
              onClick={() =>
                onChange({ threatActor: filters.threatActor === a.value ? null : a.value })
              }
            />
          ))}
        </div>
      )}

      {(showNotRunYet || showHasBinary) && (
        <div className="flex flex-col gap-2.5 px-2">
          {showNotRunYet && (
            <label className="flex items-center justify-between gap-2 text-xs text-muted">
              Not run yet
              <Switch
                checked={filters.notRunYet}
                onCheckedChange={(checked) => onChange({ notRunYet: checked })}
              />
            </label>
          )}
          {showHasBinary && (
            <label className="flex items-center justify-between gap-2 text-xs text-muted">
              Has binary
              <Switch
                checked={filters.hasBinary}
                onCheckedChange={(checked) => onChange({ hasBinary: checked })}
              />
            </label>
          )}
        </div>
      )}
    </div>
  );
}
