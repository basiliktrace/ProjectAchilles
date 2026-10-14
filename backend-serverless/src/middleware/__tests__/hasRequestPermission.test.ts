import { describe, it, expect, vi } from 'vitest';
import type { Request } from 'express';

vi.mock('@clerk/express', () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../services/agent/database.js', () => ({ getDb: vi.fn() }));

const { hasRequestPermission } = await import('../clerk.middleware.js');
const req = (auth: unknown) => ({ auth }) as unknown as Request;

describe('hasRequestPermission', () => {
  it('follows the Clerk role', () => {
    expect(hasRequestPermission(req({ sessionClaims: { metadata: { role: 'analyst' } } }), 'analytics:risk:read')).toBe(true);
    expect(hasRequestPermission(req({ sessionClaims: { metadata: { role: 'explorer' } } }), 'analytics:risk:read')).toBe(false);
  });
});
