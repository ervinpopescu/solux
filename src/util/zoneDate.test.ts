import { describe, expect, it } from 'vitest';
import {
  browserZone,
  formatOffsetInZone,
  formatTimeInZone,
  isoDateInZone,
} from './zoneDate';

// Fixed reference instant: 2024-06-21 12:00:00 UTC
// In Europe/London  (BST, UTC+01) → 13:00  local, date 2024-06-21
// In America/New_York (EDT, UTC-04) → 08:00 local, date 2024-06-21
// In Asia/Tokyo   (JST, UTC+09) → 21:00 local, date 2024-06-21
// In Pacific/Auckland (NZST, UTC+12) → 00:00 next day 2024-06-22
const UTC_NOON = new Date('2024-06-21T12:00:00Z');

describe('isoDateInZone', () => {
  it('returns yyyy-MM-dd for Europe/London (BST, same calendar day)', () => {
    expect(isoDateInZone(UTC_NOON, 'Europe/London')).toBe('2024-06-21');
  });

  it('returns yyyy-MM-dd for America/New_York (EDT, same calendar day)', () => {
    expect(isoDateInZone(UTC_NOON, 'America/New_York')).toBe('2024-06-21');
  });

  it('rolls to the NEXT calendar day for UTC+12 (Pacific/Auckland)', () => {
    // 2024-06-21 12:00 UTC = 2024-06-22 00:00 NZST
    expect(isoDateInZone(UTC_NOON, 'Pacific/Auckland')).toBe('2024-06-22');
  });

  it('produces a valid ISO date string pattern', () => {
    const result = isoDateInZone(UTC_NOON, 'UTC');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('formatTimeInZone', () => {
  it('formats 12:00 UTC as 13:00 in Europe/London (BST)', () => {
    expect(formatTimeInZone(UTC_NOON, 'Europe/London')).toBe('13:00');
  });

  it('formats 12:00 UTC as 08:00 in America/New_York (EDT)', () => {
    expect(formatTimeInZone(UTC_NOON, 'America/New_York')).toBe('08:00');
  });

  it('formats 12:00 UTC as 21:00 in Asia/Tokyo (JST)', () => {
    expect(formatTimeInZone(UTC_NOON, 'Asia/Tokyo')).toBe('21:00');
  });

  it('formats 12:00 UTC as 12:00 in UTC', () => {
    expect(formatTimeInZone(UTC_NOON, 'UTC')).toBe('12:00');
  });

  it('returns HH:MM format (zero-padded)', () => {
    // 2024-06-21 01:05:00 UTC
    const earlyMorning = new Date('2024-06-21T01:05:00Z');
    expect(formatTimeInZone(earlyMorning, 'UTC')).toBe('01:05');
  });
});

describe('formatOffsetInZone', () => {
  it('returns UTC+01:00 for Europe/London in summer (BST)', () => {
    expect(formatOffsetInZone(UTC_NOON, 'Europe/London')).toBe('UTC+01:00');
  });

  it('returns UTC-04:00 for America/New_York in summer (EDT)', () => {
    expect(formatOffsetInZone(UTC_NOON, 'America/New_York')).toBe('UTC-04:00');
  });

  it('returns UTC+09:00 for Asia/Tokyo (no DST)', () => {
    expect(formatOffsetInZone(UTC_NOON, 'Asia/Tokyo')).toBe('UTC+09:00');
  });

  it('returns UTC+00:00 for UTC', () => {
    expect(formatOffsetInZone(UTC_NOON, 'UTC')).toBe('UTC+00:00');
  });

  it('correctly switches offset at a DST boundary', () => {
    // Europe/London: 2024-03-31 01:00:00 UTC is the moment clocks go forward.
    // Just before: UTC+00:00 (GMT). Just after: UTC+01:00 (BST).
    const beforeDst = new Date('2024-03-31T00:59:00Z');
    const afterDst  = new Date('2024-03-31T01:01:00Z');
    expect(formatOffsetInZone(beforeDst, 'Europe/London')).toBe('UTC+00:00');
    expect(formatOffsetInZone(afterDst,  'Europe/London')).toBe('UTC+01:00');
  });
});

describe('browserZone', () => {
  it('returns a non-empty IANA timezone string', () => {
    const zone = browserZone();
    expect(typeof zone).toBe('string');
    expect(zone.length).toBeGreaterThan(0);
  });

  it('contains a slash (canonical IANA form) or is "UTC"', () => {
    const zone = browserZone();
    // All canonical IANA zones (except UTC) contain a slash.
    expect(zone === 'UTC' || zone.includes('/')).toBe(true);
  });
});
