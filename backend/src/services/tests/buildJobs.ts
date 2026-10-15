import type { BuildJob } from '../../types/tests.js';

interface Entry<T> {
  job: BuildJob;
  promise: Promise<T>;
}

/**
 * Tracks the latest build job per key (test UUID) in memory.
 *
 * A Go build can run for minutes, far longer than reverse proxies wait for a
 * response (nginx: 60 s), so a build must be able to outlive the request that
 * started it. Callers either await the returned promise (synchronous API) or
 * poll get() (async API). Calling run() while a job for the same key is still
 * running joins that job, so two builds never write into the same directories.
 *
 * State lives in this process only: a restart forgets every job, which is
 * correct because the restart also killed the build itself.
 */
export class BuildJobs<T> {
  private entries = new Map<string, Entry<T>>();

  run(key: string, fn: () => Promise<T>): { job: BuildJob; promise: Promise<T> } {
    const current = this.entries.get(key);
    if (current && current.job.status === 'running') {
      return { job: { ...current.job }, promise: current.promise };
    }

    const job: BuildJob = { status: 'running', startedAt: new Date().toISOString() };
    // resolve(fn()) runs fn now and turns a synchronous throw into a rejection.
    const promise = new Promise<T>((resolve) => resolve(fn()));
    this.entries.set(key, { job, promise });

    // Registered before any caller's handler, so status is final by the time a
    // caller's await resumes. Handling the rejection here also means a failing
    // job nobody awaits (async API) never becomes an unhandled rejection;
    // callers still receive the original promise, which rejects as usual.
    promise.then(
      () => {
        job.status = 'succeeded';
        job.finishedAt = new Date().toISOString();
      },
      (err: unknown) => {
        job.status = 'failed';
        job.finishedAt = new Date().toISOString();
        job.error = err instanceof Error ? err.message : String(err);
      },
    );

    return { job: { ...job }, promise };
  }

  get(key: string): BuildJob | undefined {
    const entry = this.entries.get(key);
    return entry ? { ...entry.job } : undefined;
  }

  isRunning(key: string): boolean {
    return this.entries.get(key)?.job.status === 'running';
  }
}
