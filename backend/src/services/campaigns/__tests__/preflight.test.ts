import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { createTestDatabase, insertTestAgent } from '../../../__tests__/helpers/db.js';
import type { Campaign } from '../types.js';

let testDb: Database.Database;
const state = vi.hoisted(() => ({ home: '/tmp' }));
vi.mock('../../agent/database.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent/database.js')>()),
  getDatabase: () => testDb,
}));
vi.mock('../../agent/test-catalog.service.js', () => ({
  getTestMetadata: (uuid: string) => (uuid.startsWith('gone-') ? null : { uuid, name: `Test ${uuid}`, techniques: [] }),
}));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const overrides = { homedir: () => state.home };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

const { preflightCampaign } = await import('../preflight.js');

function writeBuild(uuid: string, meta: unknown, files: Record<string, string>) {
  const dir = path.join(state.home, '.projectachilles', 'builds', uuid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'build-meta.json'), JSON.stringify(meta));
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c);
}

const camp = (test_uuids: string[], agent_ids: string[]): Campaign => ({
  id: 'c1', org_id: 'org-1', name: 'C', description: null, framework_label: null,
  test_uuids, agent_ids, created_by: 'u', created_at: '', updated_at: '',
});

describe('preflightCampaign', () => {
  beforeEach(() => {
    state.home = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
    testDb = createTestDatabase();
    insertTestAgent(testDb, { id: 'win', org_id: 'org-1', hostname: 'hw', os: 'windows' });
    insertTestAgent(testDb, { id: 'lin', org_id: 'org-1', hostname: 'hl', os: 'linux' });
    insertTestAgent(testDb, { id: 'dec', org_id: 'org-1', hostname: 'hd', os: 'windows', status: 'decommissioned' });
  });
  afterEach(() => fs.rmSync(state.home, { recursive: true, force: true }));

  it('windows-only test: dispatches windows agent, skips linux with no linux binary', () => {
    writeBuild('t1', { binaries: { windows: { filename: 't1.exe' } } }, { 't1.exe': 'x' });
    const r = preflightCampaign(camp(['t1'], ['win', 'lin']));
    expect(r.dispatch).toEqual([{ test_uuid: 't1', test_name: 'Test t1', binary_name: 't1.exe', agent_ids: ['win'] }]);
    expect(r.skipped).toEqual([{ test_uuid: 't1', agent_id: 'lin', reason: 'no linux binary' }]);
    expect(r.task_count).toBe(1);
    expect(r.tests).toEqual([{ uuid: 't1', name: 'Test t1' }]);
    expect(r.agents).toEqual([
      { id: 'win', hostname: 'hw', os: 'windows' },
      { id: 'lin', hostname: 'hl', os: 'linux' },
    ]);
  });

  it('skips non-active, deleted agents and uncatalogued tests; counts dispatchable pairs', () => {
    writeBuild('t1', { filename: 't1.exe' }, { 't1.exe': 'x' });
    const r = preflightCampaign(camp(['t1', 'gone-1', 't9'], ['win', 'dec', 'ghost']));
    expect(r.skipped).toEqual(expect.arrayContaining([
      { test_uuid: 't1', agent_id: 'dec', reason: 'agent decommissioned' },
      { test_uuid: 't1', agent_id: 'ghost', reason: 'agent deleted' },
      { test_uuid: 'gone-1', agent_id: 'win', reason: 'removed from library' },
      { test_uuid: 'gone-1', agent_id: 'dec', reason: 'removed from library' },
      { test_uuid: 'gone-1', agent_id: 'ghost', reason: 'removed from library' },
      { test_uuid: 't9', agent_id: 'win', reason: 'not built' },
    ]));
    expect(r.task_count).toBe(1);
    expect(r.dispatch).toHaveLength(1);
    expect(r.agents.map((a) => a.id)).toEqual(['win', 'dec']);
  });

  it('org-scopes agents: foreign agent skipped and not exposed; missing id stays deleted', () => {
    insertTestAgent(testDb, { id: 'foe', org_id: 'org-2', hostname: 'secret-host', os: 'windows' });
    writeBuild('t1', { filename: 't1.exe' }, { 't1.exe': 'x' });
    const r = preflightCampaign(camp(['t1', 't2'], ['win', 'foe', 'ghost']));
    expect(r.skipped).toEqual(expect.arrayContaining([
      { test_uuid: 't1', agent_id: 'foe', reason: 'agent not in organization' },
      { test_uuid: 't1', agent_id: 'ghost', reason: 'agent deleted' },
    ]));
    expect(JSON.stringify(r)).not.toContain('secret-host');
    expect(r.agents.map((a) => a.id)).toEqual(['win']);
  });

  it('resolves once per (test, os), without hashing', () => {
    for (let i = 0; i < 5; i++) insertTestAgent(testDb, { id: `w${i}`, org_id: 'org-1', hostname: `w${i}`, os: 'windows' });
    writeBuild('t1', { filename: 't1.exe' }, { 't1.exe': 'x' });
    const exists = vi.spyOn(fs, 'existsSync');
    const read = vi.spyOn(fs, 'readFileSync');
    const r = preflightCampaign(camp(['t1'], ['w0', 'w1', 'w2', 'w3', 'w4']));
    expect(r.task_count).toBe(5);
    const binChecks = exists.mock.calls.filter((c) => String(c[0]).endsWith('t1.exe'));
    expect(binChecks).toHaveLength(1);
    expect(read.mock.calls.filter((c) => String(c[0]).endsWith('t1.exe'))).toHaveLength(0);
    vi.restoreAllMocks();
  });
});
