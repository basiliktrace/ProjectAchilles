import { describe, it, expect } from 'vitest';
import { isFullyAccepted } from '../acceptance.js';

describe('isFullyAccepted', () => {
  it('true when every recipient is accepted (case-insensitive)', () => {
    expect(
      isFullyAccepted(['A@x.com', 'b@x.com'], { accepted: ['a@x.com', 'b@x.com'], rejected: [] }),
    ).toBe(true);
  });
  it('false when a recipient is missing', () => {
    expect(isFullyAccepted(['a@x.com', 'b@x.com'], { accepted: ['a@x.com'], rejected: [] })).toBe(false);
  });
  it('false when anything is rejected', () => {
    expect(
      isFullyAccepted(['a@x.com'], { accepted: ['a@x.com'], rejected: ['c@x.com'] }),
    ).toBe(false);
  });
  it('false for empty recipients', () => {
    expect(isFullyAccepted([], { accepted: [], rejected: [] })).toBe(false);
  });
});
