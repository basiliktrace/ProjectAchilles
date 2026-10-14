import { describe, it, expect, vi } from 'vitest';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));
vi.mock('@/hooks/useAuthenticatedApi', () => ({ apiClient: { get: getMock } }));

const { reportsApi } = await import('../reports');

describe('reportsApi.getExecutionReport', () => {
  it('sends the filter params and tz, and unwraps the envelope', async () => {
    getMock.mockResolvedValue({ data: { success: true, data: { meta: { reportId: 'RPT-1' } } } });
    const report = await reportsApi.getExecutionReport({ from: 'now-30d', result: 'unprotected', tz: 'UTC' });
    expect(getMock).toHaveBeenCalledWith('/reports/executions', { params: { from: 'now-30d', result: 'unprotected', tz: 'UTC' } });
    expect(report).toEqual({ meta: { reportId: 'RPT-1' } });
  });
});
