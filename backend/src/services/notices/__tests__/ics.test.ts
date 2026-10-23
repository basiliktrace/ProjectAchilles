import { describe, it, expect } from 'vitest';
import { buildIcs } from '../ics.js';

const base = {
  uid: 'u1@pa', sequence: 1, start: new Date('2026-10-23T13:05:00Z'),
  end: new Date('2026-10-23T15:05:00Z'), summary: 'x', description: 'd', stamp: new Date('2026-10-23T13:00:00Z'),
};

describe('buildIcs', () => {
  it('has required properties', () => {
    const ics = buildIcs(base);
    for (const k of ['BEGIN:VCALENDAR', 'METHOD:PUBLISH', 'UID:', 'SEQUENCE:1', 'DTSTART:20261023T130500Z', 'DTEND:20261023T150500Z', 'DTSTAMP:20261023T130000Z']) {
      expect(ics).toContain(k);
    }
  });
  it('uses CRLF and folds at 75 octets, including multibyte', () => {
    const ics = buildIcs({ ...base, description: 'é'.repeat(200) + ' ' + 'a'.repeat(300) });
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    const lines = ics.split('\r\n').slice(0, -1);
    for (const l of lines) expect(Buffer.byteLength(l, 'utf8')).toBeLessThanOrEqual(75);
    // unfolding restores the original
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain('é'.repeat(200) + ' ' + 'a'.repeat(300));
  });
  it('escapes TEXT', () => {
    const ics = buildIcs({ ...base, summary: 'a,b;c', description: 'l1\nl2\\' });
    expect(ics).toContain('SUMMARY:a\\,b\;c\r\n');
    expect(ics).toContain('DESCRIPTION:l1\\nl2\\\\\r\n');
  });
});
