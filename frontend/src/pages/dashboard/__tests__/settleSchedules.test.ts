import { describe, it, expect } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { settleSchedules } from '../useDashboardData';
import type { Schedule } from '@/types/agent';

const prev = [{ id: 's1' }] as Schedule[];
const httpError = (status: number) =>
  new AxiosError('fail', String(status), undefined, undefined, {
    status, statusText: '', data: {}, headers: {}, config: { headers: new AxiosHeaders() },
  });

describe('settleSchedules', () => {
  it('takes the fulfilled value, including an empty list', () => {
    const next = [{ id: 's2' }] as Schedule[];
    expect(settleSchedules(prev, { status: 'fulfilled', value: next })).toBe(next);
    expect(settleSchedules(prev, { status: 'fulfilled', value: [] })).toEqual([]);
  });
  it('marks schedules unavailable (null) only on HTTP 403', () => {
    expect(settleSchedules(prev, { status: 'rejected', reason: httpError(403) })).toBeNull();
  });
  it('keeps the previous value on a transient failure', () => {
    expect(settleSchedules(prev, { status: 'rejected', reason: httpError(500) })).toBe(prev);
    expect(settleSchedules(prev, { status: 'rejected', reason: new Error('network') })).toBe(prev);
    expect(settleSchedules(null, { status: 'rejected', reason: httpError(502) })).toBeNull();
  });
});
