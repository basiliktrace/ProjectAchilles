import { describe, it, expect } from 'vitest';
import { isLowSample, seriesDelta, postureCaption, pickCurrentScore, pickCurrentErrorRate, scoreTone, postureWindowLabel } from '../posture';

describe('posture', () => {
  it('isLowSample', () => {
    expect(isLowSample(null)).toBe(true);
    expect(isLowSample(undefined)).toBe(true);
    expect(isLowSample(9)).toBe(true);
    expect(isLowSample(10)).toBe(false);
  });
  it('seriesDelta', () => {
    expect(seriesDelta([{ score: null }, { score: 50 }, { score: null }, { score: 57.5 }])).toBe(7.5);
    expect(seriesDelta([{ score: null }, { score: null }])).toBeNull();
    expect(seriesDelta([])).toBeNull();
  });
  it('postureCaption', () => {
    expect(postureCaption(8678, 2.14, '90d')).toBe('8,678 pairs · +2.1 pts over 90d');
    expect(postureCaption(8678, -1, '30d')).toBe('8,678 pairs · −1.0 pts over 30d');
    expect(postureCaption(8678, 0, '7d')).toBe('8,678 pairs · +0.0 pts over 7d');
    expect(postureCaption(8678, null, '7d')).toBe('8,678 pairs');
    expect(postureCaption(3, 5, '7d')).toBe('n=3 · not enough data');
    expect(postureCaption(0, null, '7d')).toBe('n=0 · not enough data');
  });
  it('pickCurrentScore prefers trend last point', () => {
    expect(pickCurrentScore({ score: 50, pairCount: 2 }, [{ score: 1, total: 1 }, { score: 88.9, total: 9 }]))
      .toEqual({ score: 88.9, pairCount: 9 });
    expect(pickCurrentScore({ score: 50, pairCount: 2 }, [])).toEqual({ score: 50, pairCount: 2 });
    expect(pickCurrentScore({ score: 50, pairCount: 2 }, null)).toEqual({ score: 50, pairCount: 2 });
    expect(pickCurrentScore(null, null)).toEqual({ score: null, pairCount: null });
  });
  it('scoreTone', () => {
    expect(scoreTone(null, 0)).toBe('muted');
    expect(scoreTone(20, 5)).toBe('muted');
    expect(scoreTone(55, 100)).toBe('danger');
    expect(scoreTone(70, 100)).toBe('warning');
    expect(scoreTone(85, 100)).toBe('accent');
    expect(scoreTone(80, 100)).toBe('accent');
    expect(scoreTone(60, 100)).toBe('warning');
  });
  it('postureWindowLabel mirrors the backend window rule', () => {
    expect(postureWindowLabel({ preset: '7d' })).toBe('7d');
    expect(postureWindowLabel({ preset: '90d' })).toBe('90d');
    expect(postureWindowLabel({ preset: 'all' })).toBe('last 365d');
    expect(postureWindowLabel({ preset: '400d' })).toBe('last 365d');
    expect(postureWindowLabel({ preset: '365d' })).toBe('365d');
    expect(postureWindowLabel({ preset: '48h' })).toBe('2d');
    expect(postureWindowLabel({ preset: '2w' })).toBe('14d');
    expect(
      postureWindowLabel({ preset: 'custom', from: '2026-10-01T00:00:00.000Z', to: '2026-10-11T12:00:00.000Z' }),
    ).toBe('11d');
    expect(postureWindowLabel({ preset: 'custom', from: '2024-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' })).toBe('last 365d');
  });
});

describe('pickCurrentErrorRate', () => {
  const p = (errorRate: number | null) => ({ errorRate });

  it("takes the error trend's last non-null value, so Inconclusive equals the line end", () => {
    expect(pickCurrentErrorRate([p(1), p(2.5), p(null)], 9)).toBe(2.5);
  });
  it('falls back to the error-rate endpoint when the trend has no value', () => {
    expect(pickCurrentErrorRate([p(null), p(null)], 9)).toBe(9);
    expect(pickCurrentErrorRate([], 9)).toBe(9);
    expect(pickCurrentErrorRate(null, 9)).toBe(9);
  });
  it('null when neither has a value', () => {
    expect(pickCurrentErrorRate(undefined, undefined)).toBeNull();
    expect(pickCurrentErrorRate([p(null)], null)).toBeNull();
  });
  it('a real 0 from the trend wins over the fallback', () => {
    expect(pickCurrentErrorRate([p(3), p(0)], 9)).toBe(0);
  });
});
