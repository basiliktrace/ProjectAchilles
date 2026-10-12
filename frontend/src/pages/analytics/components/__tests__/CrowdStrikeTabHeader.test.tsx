import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CrowdStrikeTabHeader from '../CrowdStrikeTabHeader';

describe('CrowdStrikeTabHeader', () => {
  it('shows the sync failure so a broken sync is not silent', () => {
    render(
      <CrowdStrikeTabHeader
        lastSync={null}
        syncing={false}
        syncError="alerts: security_exception: action [indices:admin/create] is unauthorized"
        onSync={() => {}}
      />
    );

    expect(screen.getByText('CrowdStrike sync failed')).toBeInTheDocument();
    expect(screen.getByText(/indices:admin\/create/)).toBeInTheDocument();
  });

  it('renders no error banner when the last sync was clean', () => {
    render(
      <CrowdStrikeTabHeader lastSync="2026-10-04T03:40:00.000Z" syncing={false} onSync={() => {}} />
    );

    expect(screen.queryByText('CrowdStrike sync failed')).not.toBeInTheDocument();
    expect(screen.getByText(/Last synced/)).toBeInTheDocument();
  });

  it('calls onSync when Sync Now is clicked', async () => {
    const onSync = vi.fn();
    render(<CrowdStrikeTabHeader lastSync={null} syncing={false} onSync={onSync} />);

    await userEvent.click(screen.getByRole('button', { name: /Sync Now/ }));
    expect(onSync).toHaveBeenCalledTimes(1);
  });
});
