/**
 * Pure acceptance check for the notice gate: every configured recipient
 * (case-insensitive) must be in `accepted` and `rejected` must be empty.
 */
export function isFullyAccepted(
  recipients: string[],
  r: { accepted: string[]; rejected: string[] },
): boolean {
  if (recipients.length === 0) return false;
  if (r.rejected.length > 0) return false;
  const accepted = new Set(r.accepted.map((a) => a.trim().toLowerCase()));
  return recipients.every((rcpt) => accepted.has(rcpt.trim().toLowerCase()));
}
