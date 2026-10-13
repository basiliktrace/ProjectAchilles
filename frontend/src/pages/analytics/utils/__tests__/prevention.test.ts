import { describe, it, expect } from 'vitest';
import {
  formatPreventionAction,
  isConfirmedPrevention,
} from '../prevention';

describe('formatPreventionAction', () => {
  it('maps known CrowdStrike prevention actions to readable labels', () => {
    expect(formatPreventionAction('process_killed')).toBe('process killed');
    expect(formatPreventionAction('quarantined')).toBe('quarantined');
    expect(formatPreventionAction('blocked')).toBe('blocked');
    expect(formatPreventionAction('kill_failed')).toBe('kill failed');
  });

  it('returns null for empty / null / undefined so the caller can omit the badge', () => {
    expect(formatPreventionAction('')).toBeNull();
    expect(formatPreventionAction(null)).toBeNull();
    expect(formatPreventionAction(undefined)).toBeNull();
  });

  it('passes unrecognized actions through with underscores spaced', () => {
    // A future CrowdStrike disposition must still render — better to look
    // slightly raw than to silently drop vendor evidence.
    expect(formatPreventionAction('registry_blocked')).toBe('registry blocked');
  });
});

describe('isConfirmedPrevention', () => {
  it('treats quarantined / process_killed / blocked as vendor-confirmed prevention', () => {
    expect(isConfirmedPrevention('quarantined')).toBe(true);
    expect(isConfirmedPrevention('process_killed')).toBe(true);
    expect(isConfirmedPrevention('blocked')).toBe(true);
  });

  it('does NOT treat kill_failed as prevention — the kill was attempted and failed', () => {
    expect(isConfirmedPrevention('kill_failed')).toBe(false);
  });

  it('returns false for absent or unknown actions', () => {
    expect(isConfirmedPrevention(undefined)).toBe(false);
    expect(isConfirmedPrevention(null)).toBe(false);
    expect(isConfirmedPrevention('')).toBe(false);
    expect(isConfirmedPrevention('something_new')).toBe(false);
  });
});
