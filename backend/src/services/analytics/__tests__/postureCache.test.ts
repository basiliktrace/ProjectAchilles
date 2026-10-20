import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TtlPromiseCache } from '../postureCache.js';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeCache(over: Partial<ConstructorParameters<typeof TtlPromiseCache<number[]>>[0]> = {}) {
  return new TtlPromiseCache<number[]>({
    ttlMs: 30_000,
    maxEntries: 3,
    maxEntryWeight: 100,
    maxTotalWeight: 250,
    weigh: (v) => v.length,
    ...over,
  });
}

describe('TtlPromiseCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('concurrent callers share one in-flight load', async () => {
    const cache = makeCache();
    const d = deferred<number[]>();
    const load = vi.fn(() => d.promise);
    const a = cache.get('k', load);
    const b = cache.get('k', load);
    expect(load).toHaveBeenCalledTimes(1);
    d.resolve([1, 2]);
    expect(await a).toEqual([1, 2]);
    expect(await b).toBe(await a);
  });

  it('a settled value is a hit until the TTL from settle expires', async () => {
    const cache = makeCache();
    const load = vi.fn(async () => [1]);
    await cache.get('k', load);
    vi.advanceTimersByTime(29_999);
    await cache.get('k', load);
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(cache.size).toBe(0);
    await cache.get('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('the TTL runs from settle, not from the start of the load', async () => {
    const cache = makeCache();
    const d = deferred<number[]>();
    const p = cache.get('k', () => d.promise);
    vi.advanceTimersByTime(60_000); // a slow load
    d.resolve([1]);
    await p;
    vi.advanceTimersByTime(29_000);
    const load = vi.fn(async () => [2]);
    expect(await cache.get('k', load)).toEqual([1]);
    expect(load).not.toHaveBeenCalled();
  });

  it('a rejection is not cached', async () => {
    const cache = makeCache();
    const failing = vi.fn(async (): Promise<number[]> => {
      throw new Error('es down');
    });
    const a = cache.get('k', failing);
    const b = cache.get('k', failing);
    await expect(a).rejects.toThrow('es down');
    await expect(b).rejects.toThrow('es down');
    expect(failing).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(0);
    const ok = vi.fn(async () => [1]);
    expect(await cache.get('k', ok)).toEqual([1]);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('a synchronous throw from load becomes a rejection and is not cached', async () => {
    const cache = makeCache();
    await expect(
      cache.get('k', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(cache.size).toBe(0);
  });

  it('evicts the oldest entry beyond maxEntries', async () => {
    const cache = makeCache();
    for (const k of ['a', 'b', 'c', 'd']) await cache.get(k, async () => [1]);
    expect(cache.size).toBe(3);
    const reload = vi.fn(async () => [1]);
    await cache.get('a', reload);
    expect(reload).toHaveBeenCalledTimes(1); // 'a' was evicted
    await cache.get('d', reload);
    expect(reload).toHaveBeenCalledTimes(1); // 'd' still cached
  });

  it('serves but does not keep a value heavier than maxEntryWeight', async () => {
    const cache = makeCache();
    const big = Array.from({ length: 101 }, (_, i) => i);
    const load = vi.fn(async () => big);
    expect(await cache.get('k', load)).toBe(big);
    expect(cache.size).toBe(0);
    await cache.get('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('evicts oldest entries until the settled weight fits maxTotalWeight', async () => {
    const cache = makeCache();
    const w = (n: number) => async () => Array.from({ length: n }, () => 0);
    await cache.get('a', w(100));
    await cache.get('b', w(100));
    await cache.get('c', w(100)); // 300 > 250 → 'a' goes
    expect(cache.size).toBe(2);
    const reload = vi.fn(w(1));
    await cache.get('a', reload);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('clear() drops settled and in-flight entries; a late settle is not re-inserted', async () => {
    const cache = makeCache();
    await cache.get('a', async () => [1]);
    const d = deferred<number[]>();
    const p = cache.get('b', () => d.promise);
    cache.clear();
    expect(cache.size).toBe(0);
    d.resolve([2]);
    expect(await p).toEqual([2]); // the waiter still gets its value
    expect(cache.size).toBe(0);
  });
});
