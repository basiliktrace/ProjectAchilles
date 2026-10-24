import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const caps = vi.hoisted(() => ({ campaigns: false }));

vi.mock('@/hooks/useCapabilities', () => ({ useCapabilities: () => ({ campaigns: caps.campaigns }) }));
vi.mock('@/hooks/useAnalyticsAuth', () => ({ useAnalyticsAuth: () => ({ configured: true }) }));
vi.mock('@/hooks/useAppRole', () => ({
  useCanAccessModule: () => true,
  useHasPermission: () => true,
}));
vi.mock('@/hooks/useOutdatedAgentCount', () => ({ useOutdatedAgentCount: () => ({ outdatedCount: 0 }) }));
vi.mock('@/hooks/useAppHotkeys', () => ({ useAppHotkeys: () => undefined }));

import { AppShell } from '../AppShell';

describe('AppShell campaigns nav', () => {
  it('hides Campaigns when the capability is false', () => {
    caps.campaigns = false;
    render(<MemoryRouter><AppShell><div /></AppShell></MemoryRouter>);
    expect(screen.queryByRole('link', { name: /campaigns/i })).toBeNull();
    expect(screen.getAllByRole('link', { name: /tasks/i }).length).toBeGreaterThan(0);
  });

  it('shows Campaigns when the capability is true', () => {
    caps.campaigns = true;
    render(<MemoryRouter><AppShell><div /></AppShell></MemoryRouter>);
    expect(screen.getAllByRole('link', { name: /campaigns/i }).length).toBeGreaterThan(0);
  });
});
