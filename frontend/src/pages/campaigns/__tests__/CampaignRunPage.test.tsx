import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const api = vi.hoisted(() => ({ getRun: vi.fn(), exportRunCsv: vi.fn() }));
vi.mock('@/services/api/campaigns', () => ({ campaignsApi: api }));

import type { RunMatrix, CellState, RunNotice } from '@/services/api/campaigns';
import CampaignRunPage from '../CampaignRunPage';

const cell = (state: CellState, reason: string | null = null) =>
  ({ state, exit_code: null, task_id: 'x', completed_at: null, reason, techniques: [] });

const SENT_AT = '2026-10-23T09:55:00.000Z';
const sentNotice: RunNotice = {
  id: 'n', run_tag: 'PA-RUN-1234', state: 'sent', last_error: null, release_at: null, pickup_deadline: null,
  sent_at: SENT_AT, recipients: ['a@x.com', 'b@y.com'], override_by: null, override_reason: null, override_at: null,
};

function matrix(states: CellState[], pct: number | null = 50, notice: RunNotice | null = sentNotice): RunMatrix {
  const agents = states.map((_, i) => ({ id: `a${i}`, hostname: `host${i}`, os: 'windows' }));
  const row: Record<string, ReturnType<typeof cell>> = {};
  states.forEach((s, i) => { row[`a${i}`] = cell(s, s === 'na' || s === 'not_run' ? 'no windows binary' : null); });
  const totals = { waiting_for_notice: 0, running: 0, protected: 0, unprotected: 0, error: 0, not_run: 0, na: 0 } as RunMatrix['totals'];
  states.forEach((s) => { totals[s]++; });
  totals.percent_protected = pct;
  return {
    run: { id: 'r1', campaign_id: 'c1', campaign_name: 'CIS Baseline', framework_label: 'CIS v8', started_by: 'user_abc',
      started_by_name: 'Jane Doe', started_at: '2026-10-23T10:00:00.000Z', notice },
    tests: [{ uuid: 't1', name: 'Test One' }], agents, cells: { t1: row }, totals, as_of: '2026-10-23T10:05:00.000Z',
  };
}

function setup() {
  return render(
    <MemoryRouter initialEntries={['/campaigns/runs/r1']}>
      <Routes><Route path="/campaigns/runs/:runId" element={<CampaignRunPage />} /></Routes>
    </MemoryRouter>,
  );
}

describe('CampaignRunPage', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.useRealTimers(); });

  it('renders header and a label for every state, with reasons as titles', async () => {
    api.getRun.mockResolvedValue(matrix(['waiting_for_notice', 'running', 'protected', 'unprotected', 'error', 'not_run', 'na']));
    setup();
    const table = await screen.findByRole('table');
    for (const label of ['Waiting for notice', 'Running', 'Protected', 'Unprotected', 'Error', 'Not run', 'N/A']) {
      expect(within(table).getByText(label)).toBeInTheDocument();
    }
    expect(within(table).getByText('N/A').closest('td')).toHaveAttribute('title', 'no windows binary');
    expect(within(table).getByText('Not run').closest('td')).toHaveAttribute('title', 'no windows binary');
    expect(screen.getByText('CIS Baseline')).toBeInTheDocument();
    expect(screen.getByText('CIS v8')).toBeInTheDocument();
    expect(screen.getByText(/PA-RUN-1234/)).toBeInTheDocument();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.queryByText(/user_abc/)).not.toBeInTheDocument();
    expect(screen.getByText(/As of/)).toBeInTheDocument();
  });

  it('shows — when percent protected is null', async () => {
    api.getRun.mockResolvedValue(matrix(['error'], null));
    setup();
    expect(await screen.findByTestId('percent-protected')).toHaveTextContent('—');
  });

  it('shows percent protected and progress', async () => {
    api.getRun.mockResolvedValue(matrix(['protected', 'running', 'na'], 80));
    setup();
    expect(await screen.findByTestId('percent-protected')).toHaveTextContent('80%');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  });

  it('polls every 15s while unsettled and stops once settled', async () => {
    vi.useFakeTimers();
    api.getRun
      .mockResolvedValueOnce(matrix(['running']))
      .mockResolvedValueOnce(matrix(['protected']));
    setup();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.getRun).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(api.getRun).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(api.getRun).toHaveBeenCalledTimes(2);
  });

  it('stops polling on unmount', async () => {
    vi.useFakeTimers();
    api.getRun.mockResolvedValue(matrix(['running']));
    const { unmount } = setup();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(api.getRun).toHaveBeenCalledTimes(1);
  });

  it('prints and downloads the CSV via a blob', async () => {
    api.getRun.mockResolvedValue(matrix(['protected']));
    api.exportRunCsv.mockResolvedValue({ blob: new Blob(['a,b']), filename: 'campaign-run-r1-20261023T1005Z.csv' });
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    const createUrl = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const user = userEvent.setup();
    setup();
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: /Print/ }));
    expect(print).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /Download CSV/ }));
    await vi.waitFor(() => expect(click).toHaveBeenCalled());
    expect(api.exportRunCsv).toHaveBeenCalledWith('r1');
    expect(createUrl).toHaveBeenCalled();
    expect(click.mock.instances[0]).toHaveProperty('download', 'campaign-run-r1-20261023T1005Z.csv');
  });
  it('notice record: sent shows run tag, local sent time and recipients', async () => {
    api.getRun.mockResolvedValue(matrix(['protected']));
    setup();
    const rec = await screen.findByTestId('notice-record');
    expect(rec).toHaveTextContent(
      `Notice PA-RUN-1234 sent ${new Date(SENT_AT).toLocaleString()} to a@x.com, b@y.com`,
    );
  });

  it('notice record: overridden shows who released it, when and why', async () => {
    const at = '2026-10-23T09:58:00.000Z';
    api.getRun.mockResolvedValue(matrix(['protected'], 50, {
      ...sentNotice, state: 'overridden', sent_at: null, recipients: [],
      override_by: 'admin@corp.com', override_reason: 'CAB-123 approved', override_at: at,
    }));
    setup();
    const rec = await screen.findByTestId('notice-record');
    expect(rec).toHaveTextContent(
      `Notice PA-RUN-1234 released without notice by admin@corp.com at ${new Date(at).toLocaleString()}: CAB-123 approved`,
    );
  });

  it('notice record: none says notices were off', async () => {
    api.getRun.mockResolvedValue(matrix(['protected'], 50, null));
    setup();
    expect(await screen.findByTestId('notice-record')).toHaveTextContent('No pre-execution notice (notices off)');
  });

  it('notice record and started-by name are in the printed area', async () => {
    api.getRun.mockResolvedValue(matrix(['protected']));
    const { container } = setup();
    const rec = await screen.findByTestId('notice-record');
    const printArea = container.querySelector('.campaign-run-print')!;
    expect(printArea).toContainElement(rec);
    expect(printArea).toContainElement(screen.getByText('Jane Doe'));
    expect(rec.closest('.print\\:hidden')).toBeNull();
  });
});
