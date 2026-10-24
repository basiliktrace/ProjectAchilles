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
  /** true when built, or when build state could not be determined */
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [testsLoaded, setTestsLoaded] = useState(false);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
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
    setLoadError(null);
    setTestsLoaded(false);
    setAgentsLoaded(false);
    const fail = (what: string) => (err: unknown) =>
      setLoadError((prev) => prev ?? `Failed to load ${what}: ${err instanceof Error ? err.message : 'unknown error'}`);
    agentApi.listAgents({ status: 'active', limit: 1000 })
      .then((r) => { setAgents(r.agents); setAgentsLoaded(true); })
      .catch(fail('hosts'));
    // One call for build state; if it fails, build state is unknown so nothing is disabled.
    Promise.all([
      browserApi.getAllTests(),
      browserApi.getBuiltTestUuids().then((u) => new Set(u)).catch((err) => { fail('build status')(err); return null; }),
    ])
      .then(([all, built]) => {
        const options = all.map((t): TestOption => ({
          uuid: t.uuid, name: t.name, built: built === null ? true : built.has(t.uuid),
        }));
        options.sort((a, b) => a.name.localeCompare(b.name));
        setTests(options);
        setTestsLoaded(true);
      })
      .catch(fail('tests'));
  }, [open]);

  // Selected ids that can no longer be chosen: unbuilt or missing tests, inactive or deleted agents.
  const staleTests = useMemo(() => {
    if (!testsLoaded) return [];
    const byId = new Map(tests.map((t) => [t.uuid, t]));
    return [...testIds]
      .filter((id) => !byId.get(id)?.built)
      .map((id) => ({ id, label: byId.get(id)?.name ?? id }));
  }, [tests, testIds, testsLoaded]);
  const staleAgents = useMemo(() => {
    if (!agentsLoaded) return [];
    const active = new Set(agents.map((a) => a.id));
    return [...agentIds].filter((id) => !active.has(id)).map((id) => ({ id, label: id }));
  }, [agents, agentIds, agentsLoaded]);
  const staleTestIds = useMemo(() => new Set(staleTests.map((t) => t.id)), [staleTests]);

  const visibleTests = useMemo(() => {
    const q = testQuery.trim().toLowerCase();
    const list = tests.filter((t) => !staleTestIds.has(t.uuid));
    return q ? list.filter((t) => t.name.toLowerCase().includes(q)) : list;
  }, [tests, testQuery, staleTestIds]);

  const visibleAgents = useMemo(() => {
    const q = agentQuery.trim().toLowerCase();
    return q ? agents.filter((a) => a.hostname.toLowerCase().includes(q)) : agents;
  }, [agents, agentQuery]);

  function removeId(set: Set<string>, setter: (s: Set<string>) => void, id: string) {
    const next = new Set(set);
    next.delete(id);
    setter(next);
  }

  function renderStale(rows: { id: string; label: string }[], set: Set<string>, setter: (s: Set<string>) => void) {
    if (rows.length === 0) return null;
    return (
      <ul className="mt-2 space-y-1 rounded-md border border-warning/30 bg-warning-dim p-2">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
            <span>{r.label} <span className="text-xs text-warning">unavailable</span></span>
            <Button variant="outline" size="sm" aria-label={`Remove ${r.label}`}
              onClick={() => removeId(set, setter, r.id)}>Remove</Button>
          </li>
        ))}
      </ul>
    );
  }

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
          {loadError && <Alert variant="destructive">{loadError}</Alert>}
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)}
            error={errors.name} maxLength={120} />
          <Input label="Framework label" value={label} onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. CIS v8" maxLength={120} />
          <Input label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />

          <section>
            <h3 className="mb-2 text-sm font-medium">Tests ({testIds.size - staleTests.length} selected)</h3>
            <Input leftIcon={<Search className="w-4 h-4" />} placeholder="Search tests"
              aria-label="Search tests" value={testQuery} onChange={(e) => setTestQuery(e.target.value)} />
            <ul className="mt-2 max-h-48 space-y-1 overflow-auto rounded-md border border-border p-2">
              {visibleTests.map((t) => (
                <li key={t.uuid} className="flex items-center justify-between gap-2">
                  <Checkbox id={`test-${t.uuid}`} label={t.name} checked={testIds.has(t.uuid)}
                    disabled={!t.built && !testIds.has(t.uuid)} onChange={() => toggle(testIds, setTestIds, t.uuid)} />
                  {!t.built && <span className="text-xs text-muted">not built</span>}
                </li>
              ))}
            </ul>
            {renderStale(staleTests, testIds, setTestIds)}
            {errors.tests && <p className="mt-1 text-sm text-danger">{errors.tests}</p>}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-medium">Hosts ({agentIds.size - staleAgents.length} selected)</h3>
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
            {renderStale(staleAgents, agentIds, setAgentIds)}
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
