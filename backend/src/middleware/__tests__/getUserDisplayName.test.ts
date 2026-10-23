import { describe, it, expect, vi } from 'vitest';

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../services/agent/database.js', () => ({ getDatabase: vi.fn() }));

const { getUserDisplayName } = await import('../clerk.middleware.js');

describe('getUserDisplayName', () => {
  it('prefers name, then full_name, then email, then primary_email', () => {
    const all = { name: 'Jane Doe', full_name: 'Jane Q. Doe', email: 'jane@x.com', primary_email: 'j@x.com' };
    expect(getUserDisplayName({ userId: 'u', sessionClaims: all })).toBe('Jane Doe');
    expect(getUserDisplayName({ userId: 'u', sessionClaims: { ...all, name: undefined } })).toBe('Jane Q. Doe');
    expect(getUserDisplayName({ userId: 'u', sessionClaims: { email: 'jane@x.com', primary_email: 'j@x.com' } })).toBe('jane@x.com');
    expect(getUserDisplayName({ userId: 'u', sessionClaims: { primary_email: 'j@x.com' } })).toBe('j@x.com');
  });

  it('skips blank and non-string claims', () => {
    expect(getUserDisplayName({ sessionClaims: { name: '  ', full_name: 42, email: 'jane@x.com' } })).toBe('jane@x.com');
  });

  it('is undefined when no claim is present', () => {
    expect(getUserDisplayName({ userId: 'u', sessionClaims: {} })).toBeUndefined();
    expect(getUserDisplayName({ userId: 'u' })).toBeUndefined();
    expect(getUserDisplayName(undefined)).toBeUndefined();
  });
});
