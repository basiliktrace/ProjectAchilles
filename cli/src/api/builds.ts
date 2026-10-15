import { client } from './client.js';
import type { BuildInfo, BuildJob, EmbedDependency } from './types.js';

export const BUILD_POLL_INTERVAL_MS = 2000;
export const BUILD_INTERRUPTED_MESSAGE = 'Build was interrupted because the server restarted. Try again.';

export async function getBuild(uuid: string): Promise<BuildInfo> {
  return client.get(`/api/tests/builds/${uuid}`);
}

/** Poll until the test's background build finishes. */
export async function waitForBuild(uuid: string, intervalMs = BUILD_POLL_INTERVAL_MS): Promise<BuildInfo> {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const info = await getBuild(uuid);
    if (!info.job) throw new Error(BUILD_INTERRUPTED_MESSAGE);
    if (info.job.status === 'succeeded') return info;
    if (info.job.status === 'failed') throw new Error(info.job.error || 'Build failed');
  }
}

/**
 * Build & sign a test. The server builds in the background (cold Go builds
 * outlast proxy timeouts); this starts the build and waits for it.
 */
export async function createBuild(uuid: string): Promise<BuildInfo> {
  const started = await client.post<{ job: BuildJob } | BuildInfo>(
    `/api/tests/builds/${uuid}`,
    { params: { async: 'true' } },
  );
  // A server without background builds ignores ?async and returns BuildInfo.
  if ('exists' in started) return started;
  return waitForBuild(uuid);
}

export async function deleteBuild(uuid: string): Promise<void> {
  await client.delete(`/api/tests/builds/${uuid}`);
}

export async function downloadBuild(uuid: string): Promise<Response> {
  return client.get(`/api/tests/builds/${uuid}/download`, { raw: true });
}

export async function getDependencies(uuid: string): Promise<EmbedDependency[]> {
  return client.get(`/api/tests/builds/${uuid}/dependencies`);
}

export async function uploadDependency(uuid: string, file: File | Blob, filename: string): Promise<void> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('filename', filename);
  await client.post(`/api/tests/builds/${uuid}/upload`, { body: formData });
}

export async function uploadBinary(uuid: string, file: File | Blob): Promise<BuildInfo> {
  const formData = new FormData();
  formData.append('file', file);
  return client.post(`/api/tests/builds/${uuid}/upload-binary`, { body: formData });
}
