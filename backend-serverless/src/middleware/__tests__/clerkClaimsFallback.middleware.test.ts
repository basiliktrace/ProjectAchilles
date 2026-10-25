import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  clerkClient: { users: { getUser: vi.fn() } },
}));

const { hydrateClaimsFromClerk, resetClaimsFallbackCache } = await import('../clerkClaimsFallback.middleware.js');
const { getUserRole, getUserOrgId } = await import('../clerk.middleware.js');

type Auth = { userId?: string; sessionClaims?: Record<string, unknown> };

async function run(auth: unknown, load: (id: string) => Promise<Record<string, unknown>>) {
  const req = { auth } as unknown as Request;
  const next = vi.fn();
  await hydrateClaimsFromClerk(load)(req, {} as Response, next as unknown as NextFunction);
  return { req, next };
}

/** Clerk's v1 shape: req.auth is callable and also exposes the fields. */
function clerkAuth(a: Auth) {
  const fn = () => a;
  return Object.assign(fn, a);
}

describe('hydrateClaimsFromClerk()', () => {
  beforeEach(() => resetClaimsFallbackCache());

  it('fills metadata from Clerk when the session token has no metadata claim', async () => {
    const load = vi.fn().mockResolvedValue({ role: 'admin', org_id: 'org-a' });
    const { req, next } = await run(clerkAuth({ userId: 'user_1', sessionClaims: { sub: 'user_1' } }), load);

    expect(load).toHaveBeenCalledWith('user_1');
    expect(next).toHaveBeenCalledWith();
    // Both the property form and the callable form carry the role.
    expect(getUserRole(req.auth)).toBe('admin');
    expect(getUserRole((req.auth as unknown as () => Auth)())).toBe('admin');
    expect(getUserOrgId(req.auth)).toBe('org-a');
    expect((req.auth as unknown as Auth).sessionClaims?.sub).toBe('user_1');
  });

  it('trusts a token that has the metadata claim, even an empty one', async () => {
    const load = vi.fn();
    const auth = clerkAuth({ userId: 'user_1', sessionClaims: { metadata: {} } });
    const { req, next } = await run(auth, load);
    expect(load).not.toHaveBeenCalled();
    expect(req.auth).toBe(auth);
    expect(next).toHaveBeenCalledWith();
  });

  it('never looks up a token claim that says operator (no escalation from Clerk)', async () => {
    const load = vi.fn().mockResolvedValue({ role: 'admin' });
    const { req } = await run(clerkAuth({ userId: 'user_1', sessionClaims: { metadata: { role: 'operator' } } }), load);
    expect(load).not.toHaveBeenCalled();
    expect(getUserRole(req.auth)).toBe('operator');
  });

  it('skips unauthenticated requests and non-Clerk principals', async () => {
    const load = vi.fn();
    await run(undefined, load);
    await run(clerkAuth({}), load);
    await run(clerkAuth({ userId: 'cli-user', sessionClaims: {} }), load);
    expect(load).not.toHaveBeenCalled();
  });

  it('skips when req.auth() throws on a malformed token', async () => {
    const load = vi.fn();
    const { next } = await run(() => { throw new Error('Unexpected end of data'); }, load);
    expect(load).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it('caches per user and shares one lookup between concurrent requests', async () => {
    const load = vi.fn().mockResolvedValue({ role: 'analyst' });
    await Promise.all([1, 2, 3].map(() => run(clerkAuth({ userId: 'user_1', sessionClaims: {} }), load)));
    await run(clerkAuth({ userId: 'user_1', sessionClaims: {} }), load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('fails closed: a Clerk error leaves the user without a role (read-only)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const load = vi.fn().mockRejectedValue(new Error('clerk down'));
    const { req, next } = await run(clerkAuth({ userId: 'user_1', sessionClaims: {} }), load);
    expect(next).toHaveBeenCalledWith();
    expect(getUserRole(req.auth)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
