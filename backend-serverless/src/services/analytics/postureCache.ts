/**
 * Short-lived in-process cache with in-flight de-duplication, used for the
 * basis=latest pair snapshots (one Analytics page load asks for the same
 * snapshot several times at once).
 *
 * Pure and import-free on purpose so it can be copied verbatim into
 * backend-serverless/.
 *
 * - get(key, load): concurrent callers for one key share a single load().
 *   The promise is stored before anything is awaited.
 * - A rejected load is removed at once, so errors are never cached.
 * - A settled value lives `ttlMs` from settle, then a timer drops it, so the
 *   memory is released even when nobody asks again.
 * - A value heavier than `maxEntryWeight` is returned but not kept.
 * - At most `maxEntries` entries and `maxTotalWeight` settled weight are kept;
 *   the oldest entries are evicted first.
 */

export interface TtlCacheOptions<V> {
  ttlMs: number;
  maxEntries: number;
  maxEntryWeight: number;
  maxTotalWeight: number;
  weigh: (value: V) => number;
}

interface Entry<V> {
  promise: Promise<V>;
  weight: number; // 0 while in flight
  timer?: ReturnType<typeof setTimeout>;
}

export class TtlPromiseCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private totalWeight = 0;

  constructor(private readonly opts: TtlCacheOptions<V>) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key);
    if (hit) return hit.promise;

    const entry: Entry<V> = { promise: Promise.resolve(undefined as unknown as V), weight: 0 };
    // new Promise turns a synchronous throw from load() into a rejection.
    entry.promise = new Promise<V>((resolve) => resolve(load())).then(
      (value) => {
        this.settle(key, entry, value);
        return value;
      },
      (err: unknown) => {
        this.remove(key, entry);
        throw err;
      },
    );
    this.entries.set(key, entry);
    this.evict();
    return entry.promise;
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.entries.clear();
    this.totalWeight = 0;
  }

  private settle(key: string, entry: Entry<V>, value: V): void {
    if (this.entries.get(key) !== entry) return; // evicted or cleared while in flight
    const weight = this.opts.weigh(value);
    if (weight > this.opts.maxEntryWeight) {
      this.remove(key, entry);
      return;
    }
    entry.weight = weight;
    this.totalWeight += weight;
    const timer = setTimeout(() => this.remove(key, entry), this.opts.ttlMs);
    (timer as { unref?: () => void }).unref?.();
    entry.timer = timer;
    this.evict();
  }

  private remove(key: string, entry: Entry<V>): void {
    if (this.entries.get(key) !== entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.totalWeight -= entry.weight;
    this.entries.delete(key);
  }

  private evict(): void {
    for (const [key, entry] of this.entries) {
      const overCount = this.entries.size > this.opts.maxEntries;
      if (!overCount && this.totalWeight <= this.opts.maxTotalWeight) return;
      if (!overCount && entry.weight === 0) continue; // in flight: dropping it frees no weight
      this.remove(key, entry);
    }
  }
}
