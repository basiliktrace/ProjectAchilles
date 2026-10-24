import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetUser } = vi.hoisted(() => ({ mockGetUser: vi.fn() }));
vi.mock('@clerk/express', () => ({ clerkClient: { users: { getUser: mockGetUser } } }));

const { resolveUserLabel, formatUserLabel, resetUserLabelCache } = await import('../userLabel.js');

const jane = {
  firstName: 'Jane',
  lastName: 'Doe',
  primaryEmailAddressId: 'e2',
  emailAddresses: [
    { id: 'e1', emailAddress: 'old@x.io' },
    { id: 'e2', emailAddress: 'jane@x.io' },
  ],
};

beforeEach(() => {
  mockGetUser.mockReset();
  resetUserLabelCache();
});

describe('formatUserLabel', () => {
  it('name and primary email', () => {
    expect(formatUserLabel(jane, 'id')).toBe('Jane Doe (jane@x.io)');
  });
  it('email only, username only, nothing', () => {
    expect(formatUserLabel({ emailAddresses: [{ id: 'a', emailAddress: 'a@x.io' }] }, 'id')).toBe('a@x.io');
    expect(formatUserLabel({ username: 'jdoe' }, 'id')).toBe('jdoe');
    expect(formatUserLabel({}, 'user_1')).toBe('user_1');
  });
});

describe('resolveUserLabel', () => {
  it('looks the user up in Clerk', async () => {
    mockGetUser.mockResolvedValue(jane);
    expect(await resolveUserLabel('user_39yw')).toBe('Jane Doe (jane@x.io)');
    expect(mockGetUser).toHaveBeenCalledWith('user_39yw');
  });

  it('caches successful lookups for an hour', async () => {
    mockGetUser.mockResolvedValue(jane);
    const t0 = 1_000_000;
    await resolveUserLabel('user_1', t0);
    await resolveUserLabel('user_1', t0 + 59 * 60_000);
    expect(mockGetUser).toHaveBeenCalledTimes(1);
    await resolveUserLabel('user_1', t0 + 61 * 60_000);
    expect(mockGetUser).toHaveBeenCalledTimes(2);
  });

  it('falls back to the id when Clerk fails, and does not cache the failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetUser.mockRejectedValueOnce(new Error('Not Found'));
    expect(await resolveUserLabel('user_gone')).toBe('user_gone');
    mockGetUser.mockResolvedValueOnce(jane);
    expect(await resolveUserLabel('user_gone')).toBe('Jane Doe (jane@x.io)');
    warn.mockRestore();
  });

  it('gives up after 3 seconds', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetUser.mockReturnValue(new Promise(() => {}));
    const p = resolveUserLabel('user_slow');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await p).toBe('user_slow');
    vi.useRealTimers();
    warn.mockRestore();
  });

  it('does not call Clerk for ids that are not Clerk user ids', async () => {
    expect(await resolveUserLabel('alice')).toBe('alice');
    expect(await resolveUserLabel('')).toBe('');
    expect(mockGetUser).not.toHaveBeenCalled();
  });
});
