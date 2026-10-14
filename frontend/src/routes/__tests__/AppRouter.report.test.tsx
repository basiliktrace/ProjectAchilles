import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeReport } from '@/pages/analytics/report/__tests__/fixtures';
import { stubMemoryStorage } from '@/pages/analytics/report/__tests__/memoryStorage';

const { getReportMock, analyticsAuth, canAccessSettings } = vi.hoisted(() => ({
  getReportMock: vi.fn(),
  analyticsAuth: { configured: true, loading: false },
  canAccessSettings: { value: false },
}));

vi.mock('@/services/api/reports', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/api/reports')>()),
  reportsApi: { getExecutionReport: getReportMock },
}));
vi.mock('../../hooks/useAnalyticsAuth', () => ({ useAnalyticsAuth: () => analyticsAuth }));
vi.mock('../../hooks/useAppRole', () => ({ useCanAccessModule: () => canAccessSettings.value }));
vi.mock('../../components/shared/Layout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="app-shell">{children}</div>,
}));

const { default: AppRouter } = await import('../AppRouter');

function renderAt(url: string) {
  return render(<MemoryRouter initialEntries={[url]}><AppRouter /></MemoryRouter>);
}

describe('/analytics/report route', () => {
  beforeEach(() => {
    getReportMock.mockReset();
    getReportMock.mockResolvedValue(makeReport());
    analyticsAuth.configured = true;
    canAccessSettings.value = false;
    stubMemoryStorage();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders the report without the app shell', async () => {
    renderAt('/analytics/report?date=30d');
    expect(await screen.findByRole('heading', { name: 'Executive summary' })).toBeInTheDocument();
    expect(screen.getByRole('toolbar', { name: 'Report actions' })).toBeInTheDocument();
    expect(screen.queryByTestId('app-shell')).toBeNull();
    expect(getReportMock).toHaveBeenCalledWith(expect.objectContaining({ from: 'now-30d' }));
  });

  it('is gated on analytics being configured', async () => {
    analyticsAuth.configured = false;
    renderAt('/analytics/report');
    expect(await screen.findByText(/Analytics is not configured/)).toBeInTheDocument();
    expect(screen.queryByRole('toolbar', { name: 'Report actions' })).toBeNull();
    expect(getReportMock).not.toHaveBeenCalled();
  });
});
