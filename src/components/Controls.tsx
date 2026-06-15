// ==============================================================================
// Controls
// ==============================================================================
//
// Top-floating bar with:
//   - Brand label
//   - Date input + preset buttons (Today / Tomorrow / +7 days)
//   - Display-mode selector
//
// "Today" here means "today in the pinned location's timezone", not the
// browser's, so a US-based user planning a Tokyo shoot at 11 PM their time
// still gets the correct *Tokyo* date when they hit "Today". The pinned-zone
// is passed in so we can compute that.

import { useMemo } from 'react';
import { DISPLAY_MODES, type DisplayMode } from '../types';
import styles from './Controls.module.css';
import { isoDateInZone } from '../util/zoneDate';

type ControlsProps = {
  date: string;                // ISO yyyy-mm-dd
  onDateChange: (iso: string) => void;
  displayMode: DisplayMode;
  onDisplayModeChange: (mode: DisplayMode) => void;
  /** Timezone to interpret "today"/"tomorrow"/"+7 days" in. */
  pinZone: string;
  /**
   * Hide the display-mode <select>. Mobile pins the layout to the bottom
   * drawer; offering the picker would be misleading because the choice
   * is overridden.
   */
  hideDisplayMode?: boolean;
};

export default function Controls({
  date,
  onDateChange,
  displayMode,
  onDisplayModeChange,
  pinZone,
  hideDisplayMode,
}: ControlsProps) {
  // Recomputed on every render so a long-running tab doesn't get stuck on
  // yesterday's "today" after midnight. Stable function refs aren't worth
  // optimizing here — the cost is microscopic.
  const presets = useMemo(() => {
    const today = isoDateInZone(new Date(), pinZone);
    const tomorrowSrc = new Date();
    tomorrowSrc.setUTCDate(tomorrowSrc.getUTCDate() + 1);
    const tomorrow = isoDateInZone(tomorrowSrc, pinZone);
    const weekSrc = new Date();
    weekSrc.setUTCDate(weekSrc.getUTCDate() + 7);
    const inAWeek = isoDateInZone(weekSrc, pinZone);

    // Short variants are used on narrow viewports via CSS — we render both
    // forms in a <span> so the wider one can be hidden via a media query.
    //
    // `dropOnNarrow` marks presets that are hidden on very small phones
    // (≤ 420 px) where the bar can't comfortably fit them all. The first
    // two cover ≈95% of use; "+7 days" can be reached via the date input.
    return [
      { label: 'Today',    short: 'Today', value: today,   dropOnNarrow: false },
      { label: 'Tomorrow', short: 'Tmrw',  value: tomorrow, dropOnNarrow: false },
      { label: '+7 days',  short: '+7d',   value: inAWeek, dropOnNarrow: true  },
    ];
  }, [pinZone]);

  return (
    <div className={styles.bar} role="toolbar" aria-label="Solux controls">
      <span className={styles.brand} aria-label="Solux">SOLUX</span>

      <div className={styles.group}>
        <label className={styles.label} htmlFor="solux-date">Date</label>
        <input
          id="solux-date"
          type="date"
          value={date}
          onChange={(e) => onDateChange(e.target.value)}
        />
        {presets.map((p) => (
          <button
            key={p.label}
            type="button"
            className={`${styles.preset} ${p.dropOnNarrow ? styles.presetWide : ''}`}
            aria-pressed={date === p.value}
            onClick={() => onDateChange(p.value)}
            title={`${p.label} (${p.value}) in ${pinZone}`}
          >
            <span className={styles.presetLabel}>{p.label}</span>
            <span className={styles.presetLabelShort}>{p.short}</span>
          </button>
        ))}
      </div>

      {!hideDisplayMode && (
        <div className={styles.group}>
          <label className={styles.label} htmlFor="solux-display">View</label>
          <select
            id="solux-display"
            value={displayMode}
            onChange={(e) => onDisplayModeChange(e.target.value as DisplayMode)}
          >
            {DISPLAY_MODES.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
