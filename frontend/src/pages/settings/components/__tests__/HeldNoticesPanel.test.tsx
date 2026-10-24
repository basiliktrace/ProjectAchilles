import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/services/api/notices', () => ({
  noticesApi: { listPending: vi.fn(), release: vi.fn() },
}));

import { noticesApi, type NoticeListItem } from '@/services/api/notices';
import { HeldNoticesPanel } from '../HeldNoticesPanel';

const held = (o: Partial<NoticeListItem> = {}): NoticeListItem => ({
  id: 'n1', run_tag: 'PA-RUN-4f40a5', state: 'pending', kind: 'run', source_type: 'run_now',
  created_at: '2026-10-23T22:39:00.000Z', attempts: 3, last_error: 'SMTP connection failed: Connection timeout', held_tasks: 2, ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(noticesApi.release).mockResolvedValue(undefined);
});

describe('HeldNoticesPanel', () => {
  it('renders nothing when no tests are held (including a day notice with nothing linked)', async () => {
    vi.mocked(noticesApi.listPending).mockResolvedValue([held({ held_tasks: 0, kind: 'day' })]);
    const { container } = render(<HeldNoticesPanel />);
    await waitFor(() => expect(noticesApi.listPending).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('lists held runs with tag, source, held count, attempts and the last error', async () => {
    vi.mocked(noticesApi.listPending).mockResolvedValue([held()]);
    render(<HeldNoticesPanel />);
    const row = await screen.findByTestId('held-n1');
    expect(screen.getByText('1 run is waiting for its notice email')).toBeInTheDocument();
    expect(row).toHaveTextContent('PA-RUN-4f40a5');
    expect(row).toHaveTextContent('Run Now');
    expect(row).toHaveTextContent('2 tests held');
    expect(row).toHaveTextContent('3 send attempts');
    expect(row).toHaveTextContent('Last error: SMTP connection failed: Connection timeout');
  });

  it('requires a reason, releases, and refreshes the list', async () => {
    vi.mocked(noticesApi.listPending).mockResolvedValueOnce([held()]).mockResolvedValueOnce([]);
    const user = userEvent.setup();
    render(<HeldNoticesPanel />);
    const row = await screen.findByTestId('held-n1');
    await user.click(within(row).getByRole('button', { name: 'Release without notice' }));
    const go = within(row).getByRole('button', { name: 'Release now' });
    expect(go).toBeDisabled();
    await user.type(within(row).getByLabelText('Reason'), '  Mail down; SOC told by phone ');
    await user.click(go);
    await waitFor(() => expect(noticesApi.release).toHaveBeenCalledWith('n1', 'Mail down; SOC told by phone'));
    expect(await screen.findByText('PA-RUN-4f40a5 released: its tests can start now.')).toBeInTheDocument();
    expect(screen.queryByTestId('held-n1')).not.toBeInTheDocument();
  });

  it('shows the server error (e.g. no permission, or already sent) and keeps the form open', async () => {
    vi.mocked(noticesApi.listPending).mockResolvedValue([held()]);
    vi.mocked(noticesApi.release).mockRejectedValue(new Error('Notice is no longer pending'));
    const user = userEvent.setup();
    render(<HeldNoticesPanel />);
    const row = await screen.findByTestId('held-n1');
    await user.click(within(row).getByRole('button', { name: 'Release without notice' }));
    await user.type(within(row).getByLabelText('Reason'), 'x');
    await user.click(within(row).getByRole('button', { name: 'Release now' }));
    expect(await within(row).findByText('Notice is no longer pending')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Release now' })).toBeInTheDocument();
  });
});
