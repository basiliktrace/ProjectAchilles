// Per-viewer UI choices (paper size, marking). Storage can be missing or
// throw (private windows, blocked site data), so these never throw.

export function readChoice<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const value = window.localStorage.getItem(key);
    return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeChoice(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the in-memory choice still applies for this visit.
  }
}
