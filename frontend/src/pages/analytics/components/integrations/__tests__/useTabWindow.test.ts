import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTabWindow } from '../useTabWindow';

const DAY_MS = 86_400_000;

describe('useTabWindow', () => {
  it('resolves a custom range and labels it "selected range"', () => {
    const { result } = renderHook(() =>
      useTabWindow({ preset: 'custom', from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' }),
    );
    expect(result.current.window).toEqual({ from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' });
    expect(result.current.windowLabel).toBe('selected range');
  });

  it('labels the fallback window, not "selected range", when the custom range is unusable', () => {
    const { result } = renderHook(() =>
      useTabWindow({ preset: 'custom', from: '2026-10-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' }),
    );
    const { from, to } = result.current.window;
    expect(Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS)).toBe(30);
    expect(result.current.windowLabel).toBe('last 30 days');
  });

  it('refresh() bumps refreshKey and hands out a new window object', () => {
    const { result } = renderHook(() =>
      useTabWindow({ preset: 'custom', from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' }),
    );
    const before = result.current.window;
    expect(result.current.refreshKey).toBe(0);
    act(() => result.current.refresh());
    expect(result.current.refreshKey).toBe(1);
    expect(result.current.window).not.toBe(before);
    expect(result.current.window).toEqual(before);
  });
});
