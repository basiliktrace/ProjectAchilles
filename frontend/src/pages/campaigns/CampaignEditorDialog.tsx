import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Dialog, DialogHeader, DialogTitle, DialogContent, DialogFooter } from '@/components/shared/ui/Dialog';
import { Button } from '@/components/shared/ui/Button';
import { Input } from '@/components/shared/ui/Input';
import { Checkbox } from '@/components/shared/ui/Checkbox';
import { Alert } from '@/components/shared/ui/Alert';
import { agentApi } from '@/services/api/agent';
import { browserApi } from '@/services/api/browser';
import { campaignsApi, type Campaign } from '@/services/api/campaigns';
import type { AgentSummary } from '@/types/agent';

interface TestOption {
  uuid: string;
  name: string;
  built: boolean;
}

interface Props {
  open: boolean;
  /** null creates a new campaign */
  campaign: Campaign | null;
  onClose: () => void;
  onSaved: () => void;
}

export function CampaignEditorDialog({ open, campaign, onClose, onSaved }: Props) {
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [testIds, setTestIds] = useState<Set<string>>(new Set());
  const [agentIds, setAgentIds] = useState<Set<string>>(new Set());
  const [tests, setTests] = useState<TestOption[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [testQuery, setTestQuery] = useState('');
  const [agentQuery, setAgentQuery] = useState('');
  const [errors, setErrors] = useState<{ name?: string; tests?: string; agents?: string }>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset form whenever the dialog opens
  useEffect(() => {
    if (!open) return;
    setName(campaign?.name ?? '');
    setLabel(campaign?.framework_label ?? '');
    setDescription(campaign?.description ?? '');
    setTestIds(new Set(campaign?.test_uuids ?? []));
    setAgentIds(new Set(campaign?.agent_ids ?? []));
    setTestQuery('');
    setAgentQuery('');
    setErrors({});
    setSaveError(null);
  }, [open, campaign]);

  // Same data sources as TaskCreatorDialog: whole active fleet, tests with build info
  useEffect(() => {
    if (!open) return;
    agentApi.listAgents({ status: 'active', limit: 1000 })
      .then((r) => setAgents(r.agents))
      .catch(() => {});
    browserApi.getAllTests()
      .then(async (all) => {
        const options = await Promise.all(all.map(async (t): Promise<TestOption> => {
          try {
            const b = await browserApi.getBuildInfo(t.uuid);
            return { uuid: t.uuid, name: t.name, built: b.exists };
          } catch {
            return { uuid: t.uuid, name: t.name, built: false };
          }
        }));
        options.sort((a, b) => a.name.localeCompare(b.name));
        setTests(options);
      })
      .catch(() => {});
  }, [open]);

  const visibleTests = useMemo(() => {
    const q = testQuery.trim().toLowerCase();
    return q ? tests.filter((t) => t.name.toLowerCase().includes(q)) : tests;
  }, [tests, testQuery]);

  const visibleAgents = useMemo(() => {
    const q = agentQuery.trim().toLowerCase();
    return q ? agents.filter((a) => a.hostname.toLowerCase().includes(q)) : agents;
  }, [agents, agentQuery]);

  function toggle(set: Set<string>, setter: (s: Set<string>) => void, id: string) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    setter(next);
  }

  async function handleSave() {
    const next: typeof errors = {};
    if (!name.trim()) next.name = 'Name is required';
    else if (testIds.size === 0) next.tests = 'Select at least one test';
    else if (agentIds.size === 0) next.agents = 'Select at least one host';
    setErrors(next);
    setSaveError(null);
    if (Object.keys(next).length > 0) return;

    const ids = [...agentIds];
    const firstAgent = agents.find((a) => a.id === ids[0]);
    const input = {
      name: name.trim(),
      description: description.trim() || null,
      framework_label: label.trim() || null,
      test_uuids: [...testIds],
      agent_ids: ids,
    };
    setSaving(true);
    try {
      if (campaign) {
        await campaignsApi.update(campaign.id, input);
      } else {
        await campaignsApi.create({ ...input, org_id: firstAgent?.org_id ?? 'default' });
      }
      onSaved();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save campaign');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>{campaign ? 'Edit campaign' : 'New campaign'}</DialogTitle>
      </DialogHeader>
      <DialogContent>
        <div className="space-y-4">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)}
            error={errors.name} maxLength={120} />
          <Input label="Framework label" value={label} onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. CIS v8" maxLength={120} />
          <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />

          <section>
            <h3 className="mb-2 text-sm font-medium">Tests ({testIds.size} selected)</h3>
            <Input leftIcon={<Search className="w-4 h-4" />} placeholder="Search tests"
              aria-label="Search tests" value={testQuery} onChange={(e) => setTestQuery(e.target.value)} />
            <ul className="mt-2 max-h-48 space-y-1 overflow-auto rounded-md border border-border p-2">
              {visibleTests.map((t) => (
                <li key={t.uuid} className="flex items-center justify-between gap-2">
                  <Checkbox id={`test-${t.uuid}`} label={t.name} checked={testIds.has(t.uuid)}
                    disabled={!t.built} onChange={() => toggle(testIds, setTestIds, t.uuid)} />
                  {!t.built && <span className="text-xs text-muted">not built</span>}
                </li>
              ))}
            </ul>
            {errors.tests && <p className="mt-1 text-sm text-danger">{errors.tests}</p>}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-medium">Hosts ({agentIds.size} selected)</h3>
            <Input leftIcon={<Search className="w-4 h-4" />} placeholder="Search hosts"
              aria-label="Search hosts" value={agentQuery} onChange={(e) => setAgentQuery(e.target.value)} />
            <ul className="mt-2 max-h-48 space-y-1 overflow-auto rounded-md border border-border p-2">
              {visibleAgents.map((a) => (
                <li key={a.id}>
                  <Checkbox id={`agent-${a.id}`} label={a.hostname} checked={agentIds.has(a.id)}
                    onChange={() => toggle(agentIds, setAgentIds, a.id)} />
                </li>
              ))}
            </ul>
            {errors.agents && <p className="mt-1 text-sm text-danger">{errors.agents}</p>}
          </section>

          {saveError && <Alert variant="destructive">{saveError}</Alert>}
        </div>
      </DialogContent>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={() => void handleSave()} disabled={saving}>Save</Button>
      </DialogFooter>
    </Dialog>
  );
}
