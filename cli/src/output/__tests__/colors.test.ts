import { describe, it, expect } from 'vitest';
import { scoreColor, scoreOrDash } from '../colors.js';

describe('scoreOrDash', () => {
  it('renders an empty trend window (null) as a dash, not 0%', () => {
    expect(scoreOrDash(null)).toBe('—');
    expect(scoreOrDash(undefined)).toBe('—');
  });
  it('renders a real score like scoreColor, including a real 0', () => {
    expect(scoreOrDash(85)).toBe(scoreColor(85));
    expect(scoreOrDash(0)).toBe(scoreColor(0));
  });
});
