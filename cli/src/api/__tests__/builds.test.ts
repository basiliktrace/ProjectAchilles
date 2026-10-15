import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));
vi.mock('../client.js', () => ({ client: { get: getMock, post: postMock } }));

const { createBuild, BUILD_INTERRUPTED_MESSAGE } = await import('../builds.js');

const UUID = '12345678-1234-1234-1234-123456789abc';
const RUNNING = { status: 'running', startedAt: '2026-10-14T00:00:00.000Z' };
const BUILT = {
  exists: true,
  filename: `${UUID}.exe`,
  fileSize: 2048,
  signed: true,
  job: { ...RUNNING, status: 'succeeded' },
};

beforeEach(() => {
  vi.useFakeTimers();
  getMock.mockReset();
  postMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createBuild', () => {
  it('starts the build with async=true and polls until it succeeds', async () => {
    postMock.mockResolvedValue({ job: RUNNING });
    getMock
      .mockResolvedValueOnce({ exists: false, job: RUNNING })
      .mockResolvedValueOnce(BUILT);

    const result = createBuild(UUID);
    await vi.advanceTimersByTimeAsync(4000);

    await expect(result).resolves.toEqual(BUILT);
    expect(postMock).toHaveBeenCalledWith(`/api/tests/builds/${UUID}`, { params: { async: 'true' } });
    expect(getMock).toHaveBeenCalledWith(`/api/tests/builds/${UUID}`);
  });

  it('throws the build error when the job fails', async () => {
    postMock.mockResolvedValue({ job: RUNNING });
    getMock.mockResolvedValue({ exists: false, job: { ...RUNNING, status: 'failed', error: 'signing failed' } });

    const result = createBuild(UUID);
    const assertion = expect(result).rejects.toThrow('signing failed');
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
  });

  it('throws the interrupted message when the server lost the job', async () => {
    postMock.mockResolvedValue({ job: RUNNING });
    getMock.mockResolvedValue({ exists: false });

    const result = createBuild(UUID);
    const assertion = expect(result).rejects.toThrow(BUILD_INTERRUPTED_MESSAGE);
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
  });

  it('returns the BuildInfo directly when an older server built synchronously', async () => {
    postMock.mockResolvedValue(BUILT);

    await expect(createBuild(UUID)).resolves.toEqual(BUILT);
    expect(getMock).not.toHaveBeenCalled();
  });
});
