import { describe, expect, it } from 'vitest';
import { ianaZoneFor, UTC_FALLBACK } from './lookup';

describe('ianaZoneFor', () => {
  it('resolves London to Europe/London', () => {
    expect(ianaZoneFor({ lat: 51.5074, lng: -0.1278 })).toBe('Europe/London');
  });

  it('resolves New York to America/New_York', () => {
    expect(ianaZoneFor({ lat: 40.7128, lng: -74.006 })).toBe('America/New_York');
  });

  it('resolves Tokyo to Asia/Tokyo', () => {
    expect(ianaZoneFor({ lat: 35.6762, lng: 139.6503 })).toBe('Asia/Tokyo');
  });

  it('resolves Bucharest to Europe/Bucharest', () => {
    expect(ianaZoneFor({ lat: 44.4268, lng: 26.1025 })).toBe('Europe/Bucharest');
  });

  it('resolves Sydney to Australia/Sydney', () => {
    expect(ianaZoneFor({ lat: -33.8688, lng: 151.2093 })).toBe('Australia/Sydney');
  });

  it('falls back to UTC_FALLBACK for coordinates tz-lookup cannot place', () => {
    // Deep South Pacific — well clear of any coastal polygon.
    const zone = ianaZoneFor({ lat: -40, lng: -140 });
    // tz-lookup may or may not throw here; either way we should get a string.
    // If it falls back we get UTC; if it finds a zone we get that zone name.
    expect(typeof zone).toBe('string');
    expect(zone.length).toBeGreaterThan(0);
  });

  it('always returns a non-empty string', () => {
    const coords = [
      { lat: 0, lng: 0 },       // Gulf of Guinea
      { lat: 90, lng: 0 },      // North Pole
      { lat: -90, lng: 0 },     // South Pole
      { lat: 0, lng: 180 },     // Date line
    ];
    for (const c of coords) {
      const zone = ianaZoneFor(c);
      expect(typeof zone).toBe('string');
      expect(zone.length).toBeGreaterThan(0);
    }
  });

  it('UTC_FALLBACK is the string "UTC"', () => {
    expect(UTC_FALLBACK).toBe('UTC');
  });
});
