import { describe, it, expect, vi } from 'vitest';
import { BuildJobs } from '../buildJobs.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('BuildJobs', () => {
  it('records a running job and marks it succeeded with the result', async () => {
    const jobs = new BuildJobs<string>();
    const d = deferred<string>();

    const { job, promise } = jobs.run('a', () => d.promise);
    expect(job.status).toBe('running');
    expect(job.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(jobs.isRunning('a')).toBe(true);

    d.resolve('done');
    await expect(promise).resolves.toBe('done');
    const finished = jobs.get('a');
    expect(finished?.status).toBe('succeeded');
    expect(finished?.finishedAt).toBeDefined();
    expect(finished?.error).toBeUndefined();
    expect(jobs.isRunning('a')).toBe(false);
  });

  it('marks a job failed with the error message and rejects the caller promise with the original error', async () => {
    const jobs = new BuildJobs<string>();
    const boom = new Error('go build: undefined: foo');

    const { promise } = jobs.run('a', () => Promise.reject(boom));
    await expect(promise).rejects.toBe(boom);
    expect(jobs.get('a')).toMatchObject({ status: 'failed', error: 'go build: undefined: foo' });
  });

  it('turns a synchronous throw into a failed job instead of throwing from run()', async () => {
    const jobs = new BuildJobs<string>();
    const { promise } = jobs.run('a', () => { throw new Error('sync boom'); });
    await expect(promise).rejects.toThrow('sync boom');
    expect(jobs.get('a')?.status).toBe('failed');
  });

  it('joins the running job instead of starting a second one for the same key', async () => {
    const jobs = new BuildJobs<string>();
    const d = deferred<string>();
    const first = vi.fn(() => d.promise);
    const second = vi.fn(() => Promise.resolve('second'));

    const a = jobs.run('a', first);
    const b = jobs.run('a', second);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(b.promise).toBe(a.promise);
    d.resolve('first');
    await expect(b.promise).resolves.toBe('first');
  });

  it('runs keys independently', () => {
    const jobs = new BuildJobs<string>();
    const fa = vi.fn(() => new Promise<string>(() => {}));
    const fb = vi.fn(() => new Promise<string>(() => {}));
    jobs.run('a', fa);
    jobs.run('b', fb);
    expect(fa).toHaveBeenCalledTimes(1);
    expect(fb).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh job after the previous one finished', async () => {
    const jobs = new BuildJobs<string>();
    await jobs.run('a', () => Promise.reject(new Error('first failure'))).promise.catch(() => {});

    const d = deferred<string>();
    const { job } = jobs.run('a', () => d.promise);
    expect(job.status).toBe('running');
    expect(jobs.get('a')?.error).toBeUndefined();
    d.resolve('ok');
  });

  it('does not raise an unhandled rejection when nobody awaits a failing job', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      const jobs = new BuildJobs<string>();
      jobs.run('a', () => Promise.reject(new Error('nobody listens')));
      await flush();
      await flush();
      expect(onUnhandled).not.toHaveBeenCalled();
      expect(jobs.get('a')?.status).toBe('failed');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('returns copies so callers cannot mutate the registry', () => {
    const jobs = new BuildJobs<string>();
    jobs.run('a', () => new Promise<string>(() => {}));
    const copy = jobs.get('a')!;
    copy.status = 'failed';
    expect(jobs.get('a')?.status).toBe('running');
    expect(jobs.get('missing')).toBeUndefined();
  });
});
