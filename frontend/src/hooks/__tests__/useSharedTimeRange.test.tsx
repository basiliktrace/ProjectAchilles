import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useSharedTimeRange } from '../useSharedTimeRange';
import { readStoredTimeRange, storeTimeRange } from '@/lib/timeRange';

function wrapperAt(search: string) {
  return ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={[`/dashboard${search}`]}>{children}</MemoryRouter>
  );
}

function useRangeAndSearch() {
  const [range, setRange] = useSharedTimeRange();
  return { range, setRange, search: useLocation().search };
}

beforeEach(() => sessionStorage.clear());

describe('useSharedTimeRange', () => {
  it('defaults to 30d and keeps it out of the URL', () => {
    const { result } = renderHook(useRangeAndSearch, { wrapper: wrapperAt('') });
    expect(result.current.range).toEqual({ preset: '30d' });
    expect(result.current.search).toBe('');
  });

  it('opens on the range remembered from Analytics', () => {
    storeTimeRange({ preset: 'custom', from: '2026-10-01T00:00:00.000Z', to: '2026-10-11T00:00:00.000Z' });
    const { result } = renderHook(useRangeAndSearch, { wrapper: wrapperAt('') });
    expect(result.current.range.preset).toBe('custom');
    expect(result.current.search).toContain('from=');
  });

  it('stores a change and writes it to the URL', () => {
    const { result } = renderHook(useRangeAndSearch, { wrapper: wrapperAt('') });
    act(() => result.current.setRange({ preset: 'all' }));
    expect(result.current.search).toBe('?date=all');
    expect(readStoredTimeRange()).toEqual({ preset: 'all' });
  });

  it('migrates the legacy range= param to date=', () => {
    const { result } = renderHook(useRangeAndSearch, { wrapper: wrapperAt('?range=7d') });
    expect(result.current.range).toEqual({ preset: '7d' });
    expect(result.current.search).toBe('?date=7d');
    expect(readStoredTimeRange()).toEqual({ preset: '7d' });
  });
});
