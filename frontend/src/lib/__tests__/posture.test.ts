import { describe, it, expect } from 'vitest';
import { isLowSample, seriesDelta, postureCaption, pickCurrentScore, scoreTone } from '../posture';

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
});
