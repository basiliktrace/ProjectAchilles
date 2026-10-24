import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SentinelOneAutoResolveService } from '../auto-resolve.service.js';
import { SentinelOneAutoMitigationService, AUTO_MITIGATION_ACTOR } from '../auto-mitigation.service.js';
import { SentinelOneApiError, SentinelOnePermissionError } from '../s1-client.js';

const hit = (id: string, src: Record<string, unknown>) => ({ _id: `doc-${id}`, _index: 'achilles-sentinelone', _source: src });
const threatHit = (id: string) => hit(id, { alert_id: id, source_type: 'threats', f0rtika: { achilles_test_uuid: 'uuid-1' } });
const alertHit = (id: string) => hit(id, { alert_id: id, source_type: 'cloud_detection_alerts', f0rtika: { achilles_test_uuid: 'uuid-2' } });

function mockEs(hits: unknown[]) {
  return { search: vi.fn().mockResolvedValue({ hits: { hits } }), update: vi.fn().mockResolvedValue({}) };
}
function mockS1(permissionMode: 'read_only' | 'response' = 'response') {
  return {
    permissionMode,
    updateThreatIncidentStatus: vi.fn().mockResolvedValue({ affected: 1 }),
    addThreatNote: vi.fn().mockResolvedValue({ affected: 1 }),
    updateAlertIncidentStatus: vi.fn().mockResolvedValue({ affected: 1 }),
  };
}
const filters = (es: ReturnType<typeof mockEs>) => JSON.stringify(es.search.mock.calls[0][0].query);

describe('SentinelOneAutoResolveService', () => {
  it('disabled: no ES and no API calls', async () => {
    const es = mockEs([threatHit('1')]);
    const s1 = mockS1();
    const r = await new SentinelOneAutoResolveService(es as never, s1 as never, 'disabled', {}).runAutoResolvePass();
    expect(r).toMatchObject({ mode: 'disabled', candidates: 0 });
    expect(es.search).not.toHaveBeenCalled();
    expect(s1.updateThreatIncidentStatus).not.toHaveBeenCalled();
  });

  it('candidate query: matched to a test, unresolved only, in scope, not already handled in this mode', async () => {
    const es = mockEs([]);
    await new SentinelOneAutoResolveService(es as never, mockS1() as never, 'dry_run', { account_ids: ['111'], site_ids: ['222'] }).runAutoResolvePass();
    const q = filters(es);
    expect(q).toContain('"f0rtika.achilles_correlated":true');
    expect(q).toContain('"status":"unresolved"');
    expect(q).toContain('"account_id":["111"]');
    expect(q).toContain('"site_id":["222"]');
    expect(q).toContain('"f0rtika.auto_resolve_mode":"dry_run"');
    expect(es.search.mock.calls[0][0].index).toBe('achilles-sentinelone');
  });

  it('dry_run: receipts only, never calls the API', async () => {
    const es = mockEs([threatHit('1'), alertHit('2')]);
    const s1 = mockS1();
    const r = await new SentinelOneAutoResolveService(es as never, s1 as never, 'dry_run', {}).runAutoResolvePass();
    expect(r).toMatchObject({ candidates: 2, wouldPatch: 2, patched: 0 });
    expect(s1.updateThreatIncidentStatus).not.toHaveBeenCalled();
    expect(s1.updateAlertIncidentStatus).not.toHaveBeenCalled();
    expect(es.update.mock.calls[0][0].doc.f0rtika).toMatchObject({ auto_resolved: true, auto_resolve_mode: 'dry_run' });
    expect(es.update.mock.calls[0][0].doc.status).toBeUndefined();
  });

  it('enabled: threats → incident resolved + note; alerts → alert incident resolved; never a verdict or mitigation', async () => {
    const es = mockEs([threatHit('1'), alertHit('2')]);
    const s1 = mockS1();
    const r = await new SentinelOneAutoResolveService(es as never, s1 as never, 'enabled', {}).runAutoResolvePass();
    expect(r).toMatchObject({ candidates: 2, patched: 2, errors: [] });
    expect(s1.updateThreatIncidentStatus).toHaveBeenCalledWith(['1'], 'resolved');
    expect(s1.addThreatNote).toHaveBeenCalledWith(['1'], expect.stringContaining('uuid-1'));
    expect(s1.updateAlertIncidentStatus).toHaveBeenCalledWith(['2'], 'resolved');
    expect(Object.keys(s1)).not.toContain('mitigateThreats');
    expect(es.update.mock.calls[0][0].doc).toMatchObject({ status: 'resolved', f0rtika: { auto_resolve_mode: 'enabled' } });
  });

  it('enabled in read-only mode: nothing is written', async () => {
    const es = mockEs([threatHit('1')]);
    const s1 = mockS1('read_only');
    const r = await new SentinelOneAutoResolveService(es as never, s1 as never, 'enabled', {}).runAutoResolvePass();
    expect(r.errors[0]).toMatch(/read-only/);
    expect(es.search).not.toHaveBeenCalled();
    expect(s1.updateThreatIncidentStatus).not.toHaveBeenCalled();
  });

  it('a failed note does not undo the resolve; 403 halts; 404 writes a not_found receipt; transient errors retry', async () => {
    const es = mockEs([threatHit('1'), threatHit('2'), threatHit('3'), threatHit('4')]);
    const s1 = mockS1();
    s1.addThreatNote.mockRejectedValueOnce(new Error('note failed'));
    s1.updateThreatIncidentStatus
      .mockResolvedValueOnce({ affected: 1 })
      .mockRejectedValueOnce(new SentinelOneApiError('gone', 404, ''))
      .mockRejectedValueOnce(new SentinelOneApiError('timeout', 503, ''))
      .mockRejectedValueOnce(new SentinelOnePermissionError('no role'));
    const r = await new SentinelOneAutoResolveService(es as never, s1 as never, 'enabled', {}).runAutoResolvePass();
    expect(r.patched).toBe(1);
    expect(r.errors).toEqual(['2: not_found', expect.stringContaining('3: timeout'), expect.stringMatching(/^403/)]);
    const receipts = es.update.mock.calls.map((c) => c[0].id);
    expect(receipts).toEqual(['doc-1', 'doc-2']); // 3 (transient) has no receipt → retried next pass
  });
});

describe('SentinelOneAutoMitigationService', () => {
  const ok = { success: true, statusCode: 200, affected: 1, audit: {} as never };
  const exec = () => ({ execute: vi.fn().mockResolvedValue(ok) });
  const svc = (es: unknown, ex: unknown, over: Record<string, unknown> = {}) =>
    new SentinelOneAutoMitigationService(es as never, ex as never, { mode: 'enabled', action: 'kill', permissionMode: 'response', scope: {}, ...over } as never);

  it('off by default semantics: disabled, or not in Response mode → no ES / no action', async () => {
    for (const over of [{ mode: 'disabled' }, { permissionMode: 'read_only' }, { permissionMode: 'read_only', mode: 'dry_run' }]) {
      const es = mockEs([threatHit('1')]);
      const ex = exec();
      const r = await svc(es, ex, over).runAutoMitigationPass();
      expect(r.mode).toBe('disabled');
      expect(es.search).not.toHaveBeenCalled();
      expect(ex.execute).not.toHaveBeenCalled();
    }
  });

  it('refuses actions other than kill / quarantine even if passed in', async () => {
    const es = mockEs([threatHit('1')]);
    const ex = exec();
    await svc(es, ex, { action: 'remediate' }).runAutoMitigationPass();
    await svc(es, ex, { action: 'disconnect' }).runAutoMitigationPass();
    expect(ex.execute).not.toHaveBeenCalled();
  });

  it('candidates: threats only, matched to a test, not mitigated, no prevention, unresolved, in scope', async () => {
    const es = mockEs([]);
    await svc(es, exec(), { scope: { site_ids: ['222'] } }).runAutoMitigationPass();
    const q = filters(es);
    for (const part of [
      '"source_type":"threats"', '"f0rtika.achilles_correlated":true', '"status":"unresolved"',
      '"mitigation_status":"not_mitigated"', '"field":"prevention_action"', '"site_id":["222"]', '"f0rtika.auto_mitigation_mode":"enabled"',
    ]) expect(q).toContain(part);
  });

  it('dry_run logs + receipts without calling the response service', async () => {
    const es = mockEs([threatHit('1')]);
    const ex = exec();
    const r = await svc(es, ex, { mode: 'dry_run', action: 'quarantine' }).runAutoMitigationPass();
    expect(r).toMatchObject({ wouldMitigate: 1, mitigated: 0, action: 'quarantine' });
    expect(ex.execute).not.toHaveBeenCalled();
    expect(es.update.mock.calls[0][0].doc.f0rtika).toMatchObject({ auto_mitigated: true, auto_mitigation_mode: 'dry_run', auto_mitigation_action: 'quarantine' });
  });

  it('enabled: one audited threat mitigation per candidate with the configured action', async () => {
    const es = mockEs([threatHit('1'), threatHit('2')]);
    const ex = exec();
    const r = await svc(es, ex, { action: 'quarantine' }).runAutoMitigationPass();
    expect(r.mitigated).toBe(2);
    expect(ex.execute).toHaveBeenCalledWith({ kind: 'threat_mitigation', action: 'quarantine', threatIds: ['1'] }, { userId: AUTO_MITIGATION_ACTOR });
    expect(ex.execute.mock.calls.every((c) => c[0].kind === 'threat_mitigation')).toBe(true);
  });

  it('403 halts the pass', async () => {
    const es = mockEs([threatHit('1'), threatHit('2')]);
    const ex = { execute: vi.fn().mockResolvedValue({ success: false, statusCode: 403, error: 'forbidden', audit: {} }) };
    const r = await svc(es, ex).runAutoMitigationPass();
    expect(ex.execute).toHaveBeenCalledTimes(1);
    expect(r.errors[0]).toMatch(/^403/);
    expect(es.update).not.toHaveBeenCalled();
  });
});

beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}));
