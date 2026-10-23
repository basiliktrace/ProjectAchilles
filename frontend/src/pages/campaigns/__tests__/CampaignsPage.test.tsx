import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/services/api/campaigns', () => ({
  campaignsApi: {
    list: vi.fn(async () => [
      {
        id: 'c1', org_id: 'o', name: 'CIS Baseline', description: null, framework_label: 'CIS v8',
        test_uuids: ['a', 'b', 'c'], agent_ids: ['x', 'y'], created_by: 'u', created_at: '', updated_at: '',
        last_run: { id: 'r1', started_at: '2026-10-20T10:00:00.000Z', percent_protected: 75 },
      },
      {
        id: 'c2', org_id: 'o', name: 'Never Run', description: null, framework_label: null,
        test_uuids: ['a'], agent_ids: ['x'], created_by: 'u', created_at: '', updated_at: '',
        last_run: null,
      },
    ]),
    remove: vi.fn(async () => undefined),
  },
}));
vi.mock('@/hooks/useAppRole', () => ({ useHasPermission: () => true }));
vi.mock('../CampaignEditorDialog', () => ({ CampaignEditorDialog: () => null }));

import CampaignsPage from '../CampaignsPage';

describe('CampaignsPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders name, label, size and last run', async () => {
    render(<MemoryRouter><CampaignsPage /></MemoryRouter>);
    expect(await screen.findByText('CIS Baseline')).toBeInTheDocument();
    expect(screen.getByText('CIS v8')).toBeInTheDocument();
    expect(screen.getByText('3 tests × 2 hosts')).toBeInTheDocument();
    expect(screen.getByText(/75%/)).toBeInTheDocument();
    expect(screen.getByText('1 test × 1 host')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Not run yet')).toBeInTheDocument());
  });
});
