interface CoveragePipsProps {
  items: Array<{ technique: string; detected: boolean }>;
  ariaLabel?: string;
}

/**
 * Inline coverage visualization for the Detected / Prevented hero tile.
 *
 * One dot per tested technique — green = at least one execution in the window
 * was detected (prevented or detected only), red = none was. Lets a viewer eyeball the
 * breadth of coverage at a glance ("most red" vs "mostly green") without
 * needing the deeper Detection Analysis card.
 */
export default function CoveragePips({ items, ariaLabel }: CoveragePipsProps) {
  if (items.length === 0) return null;

  const detectedCount = items.filter((i) => i.detected).length;
  const label = ariaLabel ?? `${detectedCount} of ${items.length} techniques detected`;

  return (
    <div
      className="flex flex-wrap items-center gap-1"
      role="img"
      aria-label={label}
    >
      {items.map((item) => (
        <span
          key={item.technique}
          title={`${item.technique}: ${item.detected ? 'detected' : 'missed'}`}
          className={`block h-2 w-2 rounded-full ${
            item.detected ? 'bg-emerald-500' : 'bg-red-500/60'
          }`}
        />
      ))}
    </div>
  );
}
