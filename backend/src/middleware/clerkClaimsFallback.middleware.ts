// Role and org from Clerk when the session token doesn't carry them.
//
// The backend reads the role from sessionClaims.metadata, which exists only
// once the Clerk instance's session token is customised with
// {"metadata": "{{user.public_metadata}}"}. Clerk has no API to set that, so
// on a new instance every admin route returned 403 while the UI (which reads
// publicMetadata from the user object) showed the user as admin. When the
// token has no metadata claim at all, load the user's public metadata from
// Clerk instead. A token that has the claim is trusted as is.

import type { Request, Response, NextFunction } from 'express';
import { clerkClient } from '@clerk/express';
import { safeClerkAuth } from './clerkAuthHelpers.js';

type Metadata = Record<string, unknown>;
export type MetadataLoader = (userId: string) => Promise<Metadata>;

/** A role change applies within a minute, like a session token refresh. */
const TTL_MS = 60_000;
/** After a failed lookup, retry soon but don't wait on Clerk for every request. */
const FAILURE_TTL_MS = 10_000;
const LOOKUP_TIMEOUT_MS = 3_000;
const MAX_ENTRIES = 5_000;

const cache = new Map<string, { at: number; ttl: number; value: Promise<Metadata> }>();

const clerkLoader: MetadataLoader = async (userId) =>
  ((await clerkClient.users.getUser(userId)).publicMetadata ?? {}) as Metadata;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Clerk lookup timed out')), LOOKUP_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The user's Clerk public metadata, cached per user. Concurrent requests share
 * one lookup. A failed lookup yields {} (no role = read-only), never an error.
 */
function publicMetadataFor(userId: string, load: MetadataLoader, now = Date.now()): Promise<Metadata> {
  const hit = cache.get(userId);
  if (hit && now - hit.at < hit.ttl) return hit.value;
  if (cache.size >= MAX_ENTRIES) cache.clear();

  const entry = { at: now, ttl: TTL_MS, value: Promise.resolve<Metadata>({}) };
  entry.value = withTimeout(Promise.resolve().then(() => load(userId))).catch((err: unknown) => {
    entry.ttl = FAILURE_TTL_MS;
    console.warn(`[auth] Could not load Clerk metadata for ${userId}:`, err instanceof Error ? err.message : err);
    return {};
  });
  cache.set(userId, entry);
  return entry.value;
}

const hasMetadataClaim = (claims: unknown) =>
  typeof claims === 'object' && claims !== null && 'metadata' in claims;

/**
 * Runs right after clerkAuth: for a signed-in Clerk user whose token has no
 * metadata claim, replaces req.auth with the same auth plus
 * sessionClaims.metadata from Clerk, in the callable-with-fields shape
 * @clerk/express uses (as acceptCliAuth does).
 */
export function hydrateClaimsFromClerk(load: MetadataLoader = clerkLoader) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const auth = safeClerkAuth(req);
    const userId = auth?.userId;
    if (!auth || !userId?.startsWith('user_') || hasMetadataClaim(auth.sessionClaims)) return next();

    const metadata = await publicMetadataFor(userId, load);
    const enriched = { ...auth, sessionClaims: { ...((auth.sessionClaims as object | undefined) ?? {}), metadata } };
    const authFn = () => enriched;
    Object.assign(authFn, enriched);
    (req as unknown as Record<string, unknown>).auth = authFn;
    next();
  };
}

/** For tests. */
export function resetClaimsFallbackCache(): void {
  cache.clear();
}
