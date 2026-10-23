// Display name for the person who triggered a run ("Jane Doe (jane@x.io)"),
// looked up in Clerk when a notice is sent. Notices store only the Clerk
// user id, and the default session token carries no name or email.

import { clerkClient } from '@clerk/express';

const CACHE_TTL_MS = 60 * 60_000;
const LOOKUP_TIMEOUT_MS = 3_000;

const cache = new Map<string, { label: string; at: number }>();

/** Clerk user ids look like `user_…`; anything else (API keys, test ids) is shown as is. */
const isClerkUserId = (id: string) => id.startsWith('user_');

interface ClerkUserLike {
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  primaryEmailAddressId?: string | null;
  emailAddresses?: Array<{ id: string; emailAddress: string }>;
}

export function formatUserLabel(u: ClerkUserLike, fallback: string): string {
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.username || '';
  const email =
    u.emailAddresses?.find((e) => e.id === u.primaryEmailAddressId)?.emailAddress ??
    u.emailAddresses?.[0]?.emailAddress ??
    '';
  if (name && email) return `${name} (${email})`;
  return name || email || fallback;
}

/**
 * Resolves a user id to "Name (email)". Never throws and never waits more
 * than a few seconds: on any failure it returns the id, so a Clerk outage
 * can't hold up a notice. Successful lookups are cached for an hour.
 */
export async function resolveUserLabel(userId: string, now = Date.now()): Promise<string> {
  if (!userId || !isClerkUserId(userId)) return userId;
  const hit = cache.get(userId);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.label;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const user = await Promise.race([
      clerkClient.users.getUser(userId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Clerk lookup timed out')), LOOKUP_TIMEOUT_MS);
      }),
    ]);
    const label = formatUserLabel(user, userId);
    cache.set(userId, { label, at: now });
    return label;
  } catch (err) {
    console.warn(`[notices] Could not resolve user ${userId}:`, err instanceof Error ? err.message : err);
    return userId;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** For tests. */
export function resetUserLabelCache(): void {
  cache.clear();
}
