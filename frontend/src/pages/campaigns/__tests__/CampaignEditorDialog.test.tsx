import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/services/api/campaigns', () => ({ campaignsApi: api }));
vi.mock('@/services/api/agent', () => ({
  agentApi: {
    listAgents: vi.fn(async () => ({
      agents: [{ id: 'ag1', org_id: 'org-9', hostname: 'host-one', os: 'windows' }],
    })),
  },
}));
vi.mock('@/services/api/browser', () => ({
  browserApi: {
    getAllTests: vi.fn(async () => [
      { uuid: 't1', name: 'Built Test' },
      { uuid: 't2', name: 'Unbuilt Test' },
    ]),
    getBuiltTestUuids: vi.fn(async () => ['t1']),
  },
}));

import { agentApi } from '@/services/api/agent';
import { browserApi } from '@/services/api/browser';
import type { Campaign } from '@/services/api/campaigns';
import { CampaignEditorDialog } from '../CampaignEditorDialog';

function setup(campaign: Campaign | null = null) {
  const onSaved = vi.fn();
  render(<CampaignEditorDialog open campaign={campaign} onClose={vi.fn()} onSaved={onSaved} />);
  return { onSaved };
}

describe('CampaignEditorDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('validates name then selections client-side', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText('Built Test');
    await user.click(screen.getByRole('button', { name: /save/i }));
    expect(screen.getByText('Name is required')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/name/i), 'My Campaign');
    await user.click(screen.getByRole('button', { name: /save/i }));
    expect(screen.getByText('Select at least one test')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Built Test'));
    await user.click(screen.getByRole('button', { name: /save/i }));
    expect(screen.getByText('Select at least one host')).toBeInTheDocument();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('disables unbuilt tests', async () => {
    setup();
    await screen.findByText('Built Test');
    expect(screen.getByLabelText('Unbuilt Test')).toBeDisabled();
    expect(screen.getByText('not built')).toBeInTheDocument();
  });

  it('saves selected ids with the agent org and shows a 409 message', async () => {
    const user = userEvent.setup();
    api.create.mockRejectedValueOnce(new Error('A campaign with this name already exists'));
    setup();
    await screen.findByText('Built Test');
    await user.type(screen.getByLabelText(/name/i), 'Dup');
    await user.click(screen.getByLabelText('Built Test'));
    await user.click(screen.getByLabelText('host-one'));
    await user.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(api.create).toHaveBeenCalledWith(expect.objectContaining({
      org_id: 'org-9', name: 'Dup', test_uuids: ['t1'], agent_ids: ['ag1'],
    })));
    expect(await screen.findByText('A campaign with this name already exists')).toBeInTheDocument();
  });

  it('fetches build state with a single call', async () => {
    setup();
    await screen.findByText('Built Test');
    expect(browserApi.getBuiltTestUuids).toHaveBeenCalledTimes(1);
  });

  it('shows an error when hosts fail to load', async () => {
    vi.mocked(agentApi.listAgents).mockRejectedValueOnce(new Error('boom'));
    setup();
    expect(await screen.findByText(/Failed to load hosts: boom/)).toBeInTheDocument();
  });

  it('does not mark tests not built when build status fails', async () => {
    vi.mocked(browserApi.getBuiltTestUuids).mockRejectedValueOnce(new Error('nope'));
    setup();
    expect(await screen.findByText(/Failed to load build status/)).toBeInTheDocument();
    expect(screen.getByLabelText('Unbuilt Test')).not.toBeDisabled();
    expect(screen.queryByText('not built')).toBeNull();
  });

  it('shows stale selections as unavailable, removable, and omits them on save', async () => {
    const user = userEvent.setup();
    api.update.mockResolvedValueOnce({});
    const { onSaved } = setup({
      id: 'c1', org_id: 'org-9', name: 'Old', description: null, framework_label: null,
      test_uuids: ['t1', 't2', 'gone'], agent_ids: ['ag1', 'inactive-agent'],
      created_by: '', created_at: '', updated_at: '',
    });
    await screen.findByText('Built Test');
    expect(await screen.findByText('inactive-agent')).toBeInTheDocument();
    expect(screen.getByText('Unbuilt Test')).toBeInTheDocument();
    expect(screen.getAllByText('unavailable')).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: 'Remove inactive-agent' }));
    await user.click(screen.getByRole('button', { name: 'Remove Unbuilt Test' }));
    await user.click(screen.getByRole('button', { name: 'Remove gone' }));
    await user.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('c1', expect.objectContaining({
      test_uuids: ['t1'], agent_ids: ['ag1'],
    })));
    expect(onSaved).toHaveBeenCalled();
  });
});
