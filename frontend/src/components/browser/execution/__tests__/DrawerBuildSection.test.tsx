import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { BuildInfo } from '@/types/test';

const { buildTestMock } = vi.hoisted(() => ({ buildTestMock: vi.fn() }));
vi.mock('@/services/api/tests', () => ({ testsApi: { buildTest: buildTestMock } }));

const { default: DrawerBuildSection } = await import('../DrawerBuildSection');

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Like the real client: an aborted build rejects with an AbortError.
function buildThatRunsUntilAborted(_uuid: string, opts: { signal: AbortSignal }) {
  return new Promise<BuildInfo>((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

beforeEach(() => {
  buildTestMock.mockReset();
});

describe('DrawerBuildSection', () => {
  it('Build All builds one test at a time and keeps going after a failure', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<BuildInfo>>>();
    buildTestMock.mockImplementation((uuid: string) => {
      const d = deferred<BuildInfo>();
      pending.set(uuid, d);
      return d.promise;
    });
    const onBuildComplete = vi.fn();
    const builds = new Map<string, BuildInfo | null>([[A, null], [B, { exists: false }], [C, null]]);

    render(<DrawerBuildSection builds={builds} onBuildComplete={onBuildComplete} />);
    fireEvent.click(screen.getByRole('button', { name: /Build All/ }));

    await waitFor(() => expect(buildTestMock).toHaveBeenCalledTimes(1));
    expect(buildTestMock).toHaveBeenLastCalledWith(A, { signal: expect.any(AbortSignal) });

    pending.get(A)!.resolve({ exists: true });
    await waitFor(() => expect(buildTestMock).toHaveBeenCalledTimes(2));
    expect(onBuildComplete).toHaveBeenCalledWith(A, { exists: true });

    pending.get(B)!.reject(new Error('go build: undefined: foo'));
    await waitFor(() => expect(buildTestMock).toHaveBeenCalledTimes(3));

    pending.get(C)!.resolve({ exists: true });
    await waitFor(() => expect(screen.queryByText('Building all...')).not.toBeInTheDocument());
    expect(onBuildComplete).toHaveBeenCalledTimes(2);
  });

  it('stops Build All when the drawer closes', async () => {
    buildTestMock.mockImplementation(buildThatRunsUntilAborted);
    const onBuildComplete = vi.fn();
    const builds = new Map<string, BuildInfo | null>([[A, null], [B, null]]);

    const { unmount } = render(<DrawerBuildSection builds={builds} onBuildComplete={onBuildComplete} />);
    fireEvent.click(screen.getByRole('button', { name: /Build All/ }));
    await waitFor(() => expect(buildTestMock).toHaveBeenCalledTimes(1));

    unmount();
    await new Promise((r) => setTimeout(r, 0));

    expect(buildTestMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(buildTestMock).toHaveBeenCalledTimes(1);
    expect(onBuildComplete).not.toHaveBeenCalled();
  });

  it('stops a single build when the drawer closes', async () => {
    buildTestMock.mockImplementation(buildThatRunsUntilAborted);
    const onBuildComplete = vi.fn();

    const { unmount } = render(
      <DrawerBuildSection builds={new Map([[A, null]])} onBuildComplete={onBuildComplete} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Build & Sign/ }));
    await waitFor(() => expect(buildTestMock).toHaveBeenCalledTimes(1));

    unmount();
    await new Promise((r) => setTimeout(r, 0));

    expect(buildTestMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(onBuildComplete).not.toHaveBeenCalled();
  });
});
