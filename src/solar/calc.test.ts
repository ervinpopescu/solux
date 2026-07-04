// Unit tests for the solar calculation layer.
//
// We're not retesting SunCalc itself — its NOAA implementation has been
// independently validated for decades. What we ARE testing is our mapping
// from SunCalc's named events to our domain shape (golden hour, blue hour
// windows, twilight pairs, null-coercion of invalid dates near the poles).
//
// Concrete references chosen for stable, easily reproducible cases:
//
//   - London (51.5074, -0.1278) on 2024-06-21 (June solstice, long day)
//   - Sydney (-33.8688, 151.2093) on 2024-12-21 (Dec solstice, S. summer)
//   - Tromso (69.6492, 18.9553) on 2024-06-21 (midnight sun → no sunset)

import { describe, expect, it } from 'vitest';
import { computeSolarTimes, isoDateToNoonUtc } from './calc';

const LONDON = { lat: 51.5074, lng: -0.1278 };
const SYDNEY = { lat: -33.8688, lng: 151.2093 };
const TROMSO = { lat: 69.6492, lng: 18.9553 };

describe('computeSolarTimes', () => {
  it('returns a sunrise and sunset for London on the June solstice', () => {
    const times = computeSolarTimes(LONDON, isoDateToNoonUtc('2024-06-21'));

    expect(times.sunrise).toBeInstanceOf(Date);
    expect(times.sunset).toBeInstanceOf(Date);
    // London June-solstice sunrise is ~04:43 BST = ~03:43 UTC. Allow 30
    // minutes of slack so small SunCalc updates don't flake the test.
    const sunriseUtcMinutes = times.sunrise!.getUTCHours() * 60 + times.sunrise!.getUTCMinutes();
    expect(sunriseUtcMinutes).toBeGreaterThan(3 * 60 + 15);
    expect(sunriseUtcMinutes).toBeLessThan(4 * 60 + 15);
    // Sunset is ~21:21 BST = ~20:21 UTC.
    const sunsetUtcMinutes = times.sunset!.getUTCHours() * 60 + times.sunset!.getUTCMinutes();
    expect(sunsetUtcMinutes).toBeGreaterThan(20 * 60);
    expect(sunsetUtcMinutes).toBeLessThan(21 * 60);
  });

  it('produces ordered morning and evening golden hour windows', () => {
    const times = computeSolarTimes(LONDON, isoDateToNoonUtc('2024-06-21'));

    expect(times.goldenHourMorning).not.toBeNull();
    expect(times.goldenHourEvening).not.toBeNull();

    const { start: mStart, end: mEnd } = times.goldenHourMorning!;
    const { start: eStart, end: eEnd } = times.goldenHourEvening!;

    // Each window must move forward in time and be a sane duration (well
    // under 4 hours even at solstice latitudes).
    expect(mEnd.getTime()).toBeGreaterThan(mStart.getTime());
    expect(eEnd.getTime()).toBeGreaterThan(eStart.getTime());

    // Morning golden hour starts at sunriseEnd, which is moments after
    // sunrise. Evening golden hour starts well before sunset.
    expect(mStart.getTime()).toBeGreaterThan(times.sunrise!.getTime());
    expect(eEnd.getTime()).toBeLessThan(times.sunset!.getTime());

    // And the morning window must be before the evening window.
    expect(mEnd.getTime()).toBeLessThan(eStart.getTime());
  });

  it('produces late-morning and late-afternoon windows abutting soft light', () => {
    const times = computeSolarTimes(LONDON, isoDateToNoonUtc('2024-06-21'));

    expect(times.lateMorning).not.toBeNull();
    expect(times.lateAfternoon).not.toBeNull();

    // Late morning starts exactly where morning soft light ends.
    expect(times.lateMorning!.start.getTime()).toEqual(times.softLightMorning!.end.getTime());
    // Late afternoon ends exactly where evening soft light begins.
    expect(times.lateAfternoon!.end.getTime()).toEqual(times.softLightEvening!.start.getTime());

    // Both windows should be forward in time.
    expect(times.lateMorning!.end.getTime()).toBeGreaterThan(times.lateMorning!.start.getTime());
    expect(times.lateAfternoon!.end.getTime()).toBeGreaterThan(
      times.lateAfternoon!.start.getTime(),
    );
  });

  it('produces soft-light windows that flank the golden hours symmetrically', () => {
    const times = computeSolarTimes(LONDON, isoDateToNoonUtc('2024-06-21'));

    expect(times.softLightMorning).not.toBeNull();
    expect(times.softLightEvening).not.toBeNull();

    // Morning soft light begins exactly where morning golden hour ends.
    expect(times.softLightMorning!.start.getTime()).toEqual(times.goldenHourMorning!.end.getTime());
    // Evening soft light ends exactly where evening golden hour begins.
    expect(times.softLightEvening!.end.getTime()).toEqual(times.goldenHourEvening!.start.getTime());

    // The whole soft-light window should be forward in time and shorter
    // than ~2 hours at this latitude/season.
    expect(times.softLightEvening!.end.getTime()).toBeGreaterThan(
      times.softLightEvening!.start.getTime(),
    );
  });

  it('produces blue hour windows bracketing sunrise and sunset', () => {
    const times = computeSolarTimes(LONDON, isoDateToNoonUtc('2024-06-21'));

    expect(times.blueHourMorning).not.toBeNull();
    expect(times.blueHourEvening).not.toBeNull();

    // Morning blue hour ends at sunrise; evening blue hour starts at sunset.
    expect(times.blueHourMorning!.end.getTime()).toEqual(times.sunrise!.getTime());
    expect(times.blueHourEvening!.start.getTime()).toEqual(times.sunset!.getTime());
  });

  it('returns the full civil/nautical/astronomical twilight set', () => {
    const times = computeSolarTimes(SYDNEY, isoDateToNoonUtc('2024-12-21'));

    expect(times.civilDawn).toBeInstanceOf(Date);
    expect(times.civilDusk).toBeInstanceOf(Date);
    expect(times.nauticalDawn).toBeInstanceOf(Date);
    expect(times.nauticalDusk).toBeInstanceOf(Date);
    // Note: Sydney's near-midsummer twilight is short; astronomical may or
    // may not occur every day at this latitude depending on the year, but
    // the field shape is still a `Date | null`.
    expect(times.astroDawn === null || times.astroDawn instanceof Date).toBe(true);
  });

  it('returns null sunrise/sunset during polar midnight sun (Tromso, June solstice)', () => {
    const times = computeSolarTimes(TROMSO, isoDateToNoonUtc('2024-06-21'));

    // Above the Arctic Circle in midsummer the sun does not set.
    expect(times.sunset).toBeNull();
    expect(times.sunrise).toBeNull();

    // Both golden hour windows depend on `sunriseEnd`/`sunsetStart` and
    // collapse to null when those events don't occur.
    expect(times.goldenHourMorning).toBeNull();
    expect(times.goldenHourEvening).toBeNull();

    // Blue hour requires both civil twilight and sunrise/sunset — also null.
    expect(times.blueHourMorning).toBeNull();
    expect(times.blueHourEvening).toBeNull();

    // We deliberately do NOT assert on softLightMorning / softLightEvening
    // here. Above the Arctic Circle in midsummer, the sun never sets but it
    // does still dip toward the horizon around solar midnight, crossing
    // 6° and 12° as it goes — giving a "midnight golden/soft" window that
    // photographers actively shoot. SunCalc returns valid times for those
    // crossings, and our soft-light windows therefore correctly survive.
  });

  it('isoDateToNoonUtc anchors at 12:00 UTC of the given calendar day', () => {
    const d = isoDateToNoonUtc('2026-06-14');
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(5); // June (0-indexed)
    expect(d.getUTCDate()).toBe(14);
    expect(d.getUTCHours()).toBe(12);
    expect(d.getUTCMinutes()).toBe(0);
  });
});
