import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let home: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const overrides = { homedir: () => home };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

const { resolveTestArtifact } = await import('../testArtifacts.js');

function writeBuild(uuid: string, meta: unknown | null, files: Record<string, string> = {}) {
  const dir = path.join(home, '.projectachilles', 'builds', uuid);
  fs.mkdirSync(dir, { recursive: true });
  if (meta) fs.writeFileSync(path.join(dir, 'build-meta.json'), JSON.stringify(meta));
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c);
}

describe('resolveTestArtifact', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-'));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('resolves a legacy single-binary meta for any OS', () => {
    writeBuild('t1', { filename: 't1.exe' }, { 't1.exe': 'abc' });
    for (const o of ['windows', 'linux', 'darwin'] as const) {
      const r = resolveTestArtifact('t1', o);
      expect(r).toMatchObject({ ok: true, binaryName: 't1.exe', size: 3 });
      expect(r.ok && r.sha256).toHaveLength(64);
    }
  });

  it('resolves per-OS from a binaries map', () => {
    writeBuild('t2', { binaries: { windows: { filename: 'w.exe' }, linux: { filename: 'l' } } }, { 'w.exe': 'w', l: 'll' });
    expect(resolveTestArtifact('t2', 'linux')).toMatchObject({ ok: true, binaryName: 'l', size: 2 });
  });

  it('reports no <os> binary when the map lacks the OS', () => {
    writeBuild('t3', { binaries: { windows: { filename: 'w.exe' } } }, { 'w.exe': 'w' });
    expect(resolveTestArtifact('t3', 'linux')).toMatchObject({ ok: false, reason: 'no linux binary', built: ['windows'] });
  });

  it('reports binary missing on server when the file is absent', () => {
    writeBuild('t4', { filename: 'gone.exe' });
    expect(resolveTestArtifact('t4', 'windows')).toMatchObject({ ok: false, reason: 'binary missing on server', filename: 'gone.exe' });
  });

  it('reports not built when there is no build-meta', () => {
    expect(resolveTestArtifact('nope', 'windows')).toEqual({ ok: false, reason: 'not built' });
  });
});
