import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { blockStorageAccess, stubMemoryStorage } from '../../__tests__/memoryStorage';
import { readChoice, writeChoice } from '../persist';

describe('persisted choices', () => {
  let storage: Storage;
  beforeEach(() => { storage = stubMemoryStorage(); });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('round-trips an allowed value and rejects others', () => {
    writeChoice('k', 'Letter');
    expect(readChoice('k', 'A4', ['A4', 'Letter'])).toBe('Letter');
    writeChoice('k', 'Tabloid');
    expect(readChoice('k', 'A4', ['A4', 'Letter'])).toBe('A4');
  });

  it('falls back to the default when nothing was stored', () => {
    expect(readChoice('missing', 'A4', ['A4', 'Letter'])).toBe('A4');
  });

  it('falls back when storage throws (Review Focus #3)', () => {
    vi.spyOn(storage, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(readChoice('k', 'A4', ['A4', 'Letter'])).toBe('A4');
    expect(() => writeChoice('k', 'Letter')).not.toThrow();
  });

  it('falls back when the storage object itself is inaccessible', () => {
    // Blocked site data makes the `localStorage` accessor throw rather than its methods.
    blockStorageAccess();
    expect(readChoice('k', 'A4', ['A4', 'Letter'])).toBe('A4');
    expect(() => writeChoice('k', 'Letter')).not.toThrow();
  });
});
