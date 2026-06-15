// ==============================================================================
// SolarInfo
// ==============================================================================
//
// The actual content block of times. Identical content is shown in all four
// display modes (card, drawer, panel, popup) so this component is the single
// source of truth for layout, copy, and — critically — the *timezone
// disclosure* that tells the user whose clock the displayed times refer to.
//
// Why the disclosure matters: a photographer in San Francisco planning a
// shoot in Reykjavik should never have to wonder whether "06:42" is shown in
// PST or in Iceland-time. We always render in the *pinned location's*
// timezone, but the UI has to say so explicitly and prominently.
//
// Disclosure layout:
//   - Big amber "Europe/Reykjavik (UTC+00:00)" caption beneath the coords.
//   - When the pinned zone is different from the browser zone, an extra
//     italic note: "Your browser is in America/Los_Angeles — these times
//     are NOT converted to your local clock."
//   - Per-row `title` tooltips re-state the zone for hover-reassurance.

import { useMemo, useState } from 'react';
import type { LatLng, SolarTimes, TimeWindow } from '../types';
import { browserZone, formatOffsetInZone, formatTimeInZone } from '../util/zoneDate';
import { isoDateToNoonUtc } from '../solar/calc';
import { UTC_FALLBACK } from '../timezone/lookup';
import { tallestObstruction } from '../buildings/horizon';
import type { HorizonState } from '../hooks/useHorizon';
import styles from './SolarInfo.module.css';

type SolarInfoProps = {
  times: SolarTimes | null;
  /**
   * Visibility-clipped times derived from `times` + the building horizon.
   * When provided, each sun-direct row renders the effective value instead
   * of the geometric one; the geometric value is preserved in a tooltip and
   * the row is marked as "adjusted" so the user can tell what changed.
   */
  effective?: SolarTimes | null;
  zone: string;
  latLng: LatLng | null;
  /** ISO `yyyy-mm-dd`. */
  date: string;
  /** Building-aware horizon state from `useHorizon`. */
  horizon?: HorizonState;
};

/** Compass octant label for an azimuth angle. */
function compassOctant(deg: number): string {
  const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return labels[Math.round(((deg % 360) / 45)) % 8];
}

// Pretty-print a number with a fixed sign of digits. Lat/lng → 4 decimals
// (≈11 m), which is plenty for a user-readable label without taking up too
// much horizontal room.
function fmtCoord(n: number, suffixes: [string, string]): string {
  const v = Math.abs(n).toFixed(4);
  return `${v}° ${n >= 0 ? suffixes[0] : suffixes[1]}`;
}

function fmtTime(d: Date | null, zone: string): string {
  return d ? formatTimeInZone(d, zone) : '—';
}

function fmtWindow(w: TimeWindow | null, zone: string): string {
  return w ? `${formatTimeInZone(w.start, zone)} – ${formatTimeInZone(w.end, zone)}` : '—';
}

// ==============================================================================
// Helpers for choosing geometric vs effective values per row
// ==============================================================================
//
// `times` always holds the geometric values. `effective` (when present) holds
// the visibility-clipped values for sun-direct phases. We prefer the
// effective value when it differs, falling back to the geometric one
// otherwise. Twilight/blue-hour phases are sky phenomena and pass through
// unchanged in `effective`, so the "differs?" check is correctly false for
// them.

function pickInstant(
  geom: Date | null,
  eff: Date | null | undefined,
): { value: Date | null; adjusted: boolean; blocked: boolean } {
  if (eff === undefined) return { value: geom, adjusted: false, blocked: false };
  if (geom === null) return { value: null, adjusted: false, blocked: false };
  if (eff === null) return { value: null, adjusted: true, blocked: true };
  const differs = Math.abs(eff.getTime() - geom.getTime()) > 60_000;
  return { value: eff, adjusted: differs, blocked: false };
}

function pickWindow(
  geom: TimeWindow | null,
  eff: TimeWindow | null | undefined,
): { value: TimeWindow | null; adjusted: boolean; blocked: boolean } {
  if (eff === undefined) return { value: geom, adjusted: false, blocked: false };
  if (geom === null) return { value: null, adjusted: false, blocked: false };
  if (eff === null) return { value: null, adjusted: true, blocked: true };
  const startDiff = Math.abs(eff.start.getTime() - geom.start.getTime());
  const endDiff = Math.abs(eff.end.getTime() - geom.end.getTime());
  const differs = startDiff > 60_000 || endDiff > 60_000;
  return { value: eff, adjusted: differs, blocked: false };
}

type RowMeta = {
  label: string;
  value: string;
  dot?: 'gold' | 'blue' | 'dark' | 'bright';
  missing?: boolean;
  adjusted?: boolean;
  blocked?: boolean;
  geomDisplay?: string; // for tooltip
};

export default function SolarInfo({ times, effective, zone, latLng, date, horizon }: SolarInfoProps) {
  // The reference instant we use for "what is the UTC offset for this zone
  // today?". Using the selected date (anchored at noon UTC) means we report
  // the correct offset even when the user picks a date on the other side of
  // a DST transition.
  const anchor = useMemo(
    () => (date ? isoDateToNoonUtc(date) : new Date()),
    [date],
  );

  const offsetLabel = useMemo(
    () => formatOffsetInZone(anchor, zone),
    [anchor, zone],
  );

  const bz = useMemo(() => browserZone(), []);
  const showBrowserNote = bz !== zone && zone !== UTC_FALLBACK;

  // Empty state: invite the user to click the map. Mention timezone so the
  // disclosure expectation is set before they even start.
  if (!latLng || !times) {
    return (
      <div className={styles.root}>
        <p className={styles.empty}>
          Click anywhere on the map to compute sunrise, sunset, and the
          golden- and blue-hour windows in <strong>the local time of that
          location</strong>.
        </p>
      </div>
    );
  }

  const fallback = zone === UTC_FALLBACK;
  const labelMissing = (v: string) => v === '—';

  // Build a row for a single-instant phase, picking the effective value when
  // present and remembering whether it differs from geometric (for tooltip).
  function instantRow(
    label: string,
    geom: Date | null,
    eff: Date | null | undefined,
    dot: RowMeta['dot'],
  ): RowMeta {
    const picked = pickInstant(geom, eff);
    return {
      label,
      value: picked.blocked ? 'blocked' : fmtTime(picked.value, zone),
      dot,
      adjusted: picked.adjusted,
      blocked: picked.blocked,
      geomDisplay: picked.adjusted ? fmtTime(geom, zone) : undefined,
    };
  }

  function windowRow(
    label: string,
    geom: TimeWindow | null,
    eff: TimeWindow | null | undefined,
    dot: RowMeta['dot'],
  ): RowMeta {
    const picked = pickWindow(geom, eff);
    return {
      label,
      value: picked.blocked ? 'blocked' : fmtWindow(picked.value, zone),
      dot,
      adjusted: picked.adjusted,
      blocked: picked.blocked,
      geomDisplay: picked.adjusted ? fmtWindow(geom, zone) : undefined,
    };
  }

  // Order rows chronologically through a day so the eye can sweep
  // pre-dawn → morning golden hour → noon → evening golden hour → night.
  // Twilight rows (civil/nautical/astronomical + blue hour) pass through
  // `times` directly because `effective` always mirrors them unchanged.
  const rows: Array<{ section: string; items: RowMeta[] }> = [
    {
      section: 'Pre-dawn',
      items: [
        instantRow('Astronomical dawn', times.astroDawn, effective?.astroDawn, 'dark'),
        instantRow('Nautical dawn',     times.nauticalDawn, effective?.nauticalDawn, 'dark'),
        instantRow('Civil dawn',        times.civilDawn, effective?.civilDawn, 'blue'),
        windowRow ('Blue hour (AM)',    times.blueHourMorning, effective?.blueHourMorning, 'blue'),
      ],
    },
    {
      section: 'Morning',
      items: [
        instantRow('Sunrise',                times.sunrise, effective?.sunrise, 'gold'),
        windowRow ('Golden hour (AM)',       times.goldenHourMorning, effective?.goldenHourMorning, 'gold'),
        windowRow ('Soft light (AM)',        times.softLightMorning, effective?.softLightMorning, 'bright'),
        windowRow ('Late morning',           times.lateMorning, effective?.lateMorning, 'bright'),
      ],
    },
    {
      section: 'Midday',
      items: [
        instantRow('Solar noon', times.solarNoon, effective?.solarNoon, 'bright'),
      ],
    },
    {
      section: 'Evening',
      items: [
        windowRow ('Late afternoon',         times.lateAfternoon, effective?.lateAfternoon, 'bright'),
        windowRow ('Soft light (PM)',        times.softLightEvening, effective?.softLightEvening, 'bright'),
        windowRow ('Golden hour (PM)',       times.goldenHourEvening, effective?.goldenHourEvening, 'gold'),
        instantRow('Sunset',                 times.sunset, effective?.sunset, 'gold'),
      ],
    },
    {
      section: 'Post-sunset',
      items: [
        windowRow ('Blue hour (PM)',    times.blueHourEvening, effective?.blueHourEvening, 'blue'),
        instantRow('Civil dusk',        times.civilDusk, effective?.civilDusk, 'blue'),
        instantRow('Nautical dusk',     times.nauticalDusk, effective?.nauticalDusk, 'dark'),
        instantRow('Astronomical dusk', times.astroDusk, effective?.astroDusk, 'dark'),
      ],
    },
  ];

  // Mark missing values so the UI can dim them and explain. Blocked rows
  // also render via the "missing" treatment but with their own copy.
  for (const section of rows) {
    for (const item of section.items) {
      if (labelMissing(item.value) && !item.blocked) item.missing = true;
    }
  }

  const hoverTitle = `Time in ${zone} (${offsetLabel}) — the local clock at this location.`;

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.title}>
          <span className={styles.coords}>
            {fmtCoord(latLng.lat, ['N', 'S'])}, {fmtCoord(latLng.lng, ['E', 'W'])}
          </span>
          <span className={styles.date}>{date}</span>
        </div>

        {/*
         * The explicit zone caption. This is the central UX
         * promise: the user always knows whose clock they're reading.
         */}
        <div className={styles.zone} title={hoverTitle}>
          <span>Times in local time at this location</span>
        </div>
        <div className={styles.zoneCaption}>
          {fallback
            ? 'Zone: UTC (no land timezone here — open ocean)'
            : <>Zone: <strong>{zone}</strong> ({offsetLabel})</>}
        </div>

        {showBrowserNote && (
          <div className={styles.browserNote}>
            Your browser is in <strong>{bz}</strong>. The times above are
            shown in <strong>{zone}</strong> — they are <strong>not</strong>{' '}
            converted to your local clock.
          </div>
        )}
        {horizon && <BuildingsStatus horizon={horizon} />}
      </header>

      <div className={styles.rows}>
        {rows.map((section) => (
          <div className={styles.row} key={section.section}>
            <div className={styles.section}>{section.section}</div>
            {section.items.map((item) => (
              <PhaseRow
                key={item.label}
                item={item}
                hoverTitle={hoverTitle}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ==============================================================================
// PhaseRow
// ==============================================================================
//
// A single phase row. Wraps the value in a button when it has secondary
// info to reveal (adjusted/blocked geometric time) so the disclosure works
// on touch as well as via hover.

type PhaseRowProps = {
  item: RowMeta;
  hoverTitle: string;
};

function PhaseRow({ item, hoverTitle }: PhaseRowProps) {
  const [open, setOpen] = useState(false);

  const valueClass = [
    styles.value,
    item.missing ? styles.missing : '',
    item.blocked ? styles.blocked : '',
    item.adjusted && !item.blocked ? styles.adjusted : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Secondary info: shown inline when the row is "open" (clicked/tapped),
  // and as the native `title` so hover still works on desktop.
  const detail = item.blocked
    ? `Sun geometrically at ${item.geomDisplay} — obstructed by nearby buildings`
    : item.adjusted
      ? `Geometric: ${item.geomDisplay}`
      : item.missing
        ? 'Sun does not reach this phase here on this date'
        : null;

  const hasDetail = detail !== null;
  const showDetail = open && hasDetail;
  const tooltip = detail ?? hoverTitle;

  // Wrap the value as a button only when there's a disclosure to toggle —
  // this gives us free keyboard focus + ARIA semantics without forcing
  // every twilight row to be tappable.
  const valueNode = hasDetail ? (
    <button
      type="button"
      className={`${valueClass} ${styles.valueButton}`}
      title={tooltip}
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
    >
      {item.value}
    </button>
  ) : (
    <span className={valueClass} title={tooltip}>
      {item.value}
    </span>
  );

  return (
    <div className={styles.row}>
      <span className={styles.label} title={hoverTitle}>
        {item.dot && <span className={`${styles.dot} ${styles[item.dot]}`} />}
        {item.label}
      </span>
      {valueNode}
      {showDetail && (
        <span className={styles.detailLine}>{detail}</span>
      )}
    </div>
  );
}

// ==============================================================================
// BuildingsStatus
// ==============================================================================
//
// A single thin caption that explains what's been done to the times above —
// loading, errored, or a one-liner summarizing "adjusted for N buildings,
// tallest obstruction X° to the SW". No separate panel; the times in the
// main list have already been replaced with their effective values.

function BuildingsStatus({ horizon }: { horizon: HorizonState }) {
  const tallest = useMemo(
    () => (horizon.profile ? tallestObstruction(horizon.profile) : null),
    [horizon.profile],
  );

  if (horizon.status === 'idle') return null;

  if (horizon.status === 'loading') {
    return (
      <div className={styles.buildingsStatus} title="Fetching OpenStreetMap building data">
        <span className={styles.buildingsSpinner} aria-hidden /> Adjusting sun-visible times for nearby buildings…
      </div>
    );
  }

  if (horizon.status === 'error') {
    return (
      <div className={`${styles.buildingsStatus} ${styles.buildingsStatusErr}`}>
        Could not fetch nearby buildings — showing geometric times only.
      </div>
    );
  }

  // ready
  const p = horizon.profile!;
  return (
    <div className={styles.buildingsStatus}>
      Adjusted for <strong>{p.buildingCount}</strong> nearby buildings (
      {(p.radiusMeters / 1000).toFixed(0)} km radius)
      {tallest && (
        <>
          {' '}· tallest obstruction <strong>{tallest.altitudeDeg.toFixed(1)}°</strong>{' '}
          to the <strong>{compassOctant(tallest.azimuthDeg)}</strong>
        </>
      )}
      .
    </div>
  );
}
