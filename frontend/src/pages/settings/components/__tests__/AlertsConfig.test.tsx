import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/services/api/alerts', () => ({
  alertsApi: {
    getAlertSettings: vi.fn(),
    saveAlertSettings: vi.fn(),
    testAlertChannels: vi.fn(),
    getAlertHistory: vi.fn(),
  },
}));
vi.mock('@/services/api/integrations', () => ({
  integrationsApi: { getDefenderSettings: vi.fn() },
}));

import { alertsApi } from '@/services/api/alerts';
import { integrationsApi } from '@/services/api/integrations';
import { AlertsConfig } from '../AlertsConfig';

/** GET /api/integrations/alerts for an instance with saved SMTP credentials. */
const savedSettings = {
  configured: true,
  thresholds: { enabled: true },
  cooldown_minutes: 30,
  email: {
    configured: true,
    enabled: true,
    smtp_host: 'box.example.com',
    smtp_port: 465,
    smtp_secure: true,
    smtp_user: '****.com',
    from_address: 'alerts@example.com',
    recipients: ['soc@example.com'],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(alertsApi.getAlertSettings).mockResolvedValue(savedSettings as never);
  vi.mocked(alertsApi.getAlertHistory).mockResolvedValue([]);
  vi.mocked(alertsApi.saveAlertSettings).mockResolvedValue({ success: true });
  vi.mocked(alertsApi.testAlertChannels).mockResolvedValue({ success: true, data: {} } as never);
  vi.mocked(integrationsApi.getDefenderSettings).mockResolvedValue({ configured: false } as never);
});

describe('AlertsConfig with saved SMTP credentials', () => {
  it('leaves the username field empty and shows the masked value only as a hint', async () => {
    render(<AlertsConfig />);
    const user = await screen.findByLabelText('Username');
    expect(user).toHaveValue('');
    expect(user).toHaveAttribute('placeholder', expect.stringContaining('****.com'));
  });

  it('does not send the masked username back when saving or testing', async () => {
    render(<AlertsConfig />);
    await screen.findByLabelText('Username');

    await userEvent.click(screen.getByRole('button', { name: /test channels/i }));
    await waitFor(() => expect(alertsApi.testAlertChannels).toHaveBeenCalled());
    expect(vi.mocked(alertsApi.testAlertChannels).mock.calls[0][0]?.email?.smtp_user).toBeUndefined();

    await userEvent.click(screen.getByRole('button', { name: /update settings/i }));
    await waitFor(() => expect(alertsApi.saveAlertSettings).toHaveBeenCalled());
    expect(vi.mocked(alertsApi.saveAlertSettings).mock.calls[0][0].email?.smtp_user).toBeUndefined();
  });
});
