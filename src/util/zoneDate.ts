// Zone-aware date helpers.
//
// We deliberately wrap `date-fns-tz` here so the rest of the app doesn't
// have to think about format strings or pick the right Intl locale.

import { formatInTimeZone } from 'date-fns-tz';

/**
 * Format an absolute instant as `yyyy-MM-dd` in a specific IANA zone.
 *
 * This is the only way to ask "what calendar date is it RIGHT NOW in Tokyo?"
 * without rolling your own offset math. We use it both for the date picker
 * presets and for the UI labels.
 */
export function isoDateInZone(when: Date, zone: string): string {
  return formatInTimeZone(when, zone, 'yyyy-MM-dd');
}

/** Hours:minutes in a zone, e.g. "05:42". */
export function formatTimeInZone(when: Date, zone: string): string {
  return formatInTimeZone(when, zone, 'HH:mm');
}

/**
 * Compute the UTC offset label (e.g. "UTC+09:00") for a given instant in a
 * zone. We don't try to display two offsets across a DST boundary — a single
 * "today" view is always within one offset, so the simple form is honest.
 */
export function formatOffsetInZone(when: Date, zone: string): string {
  // `xxx` emits the offset as `+HH:mm` / `-HH:mm`.
  return `UTC${formatInTimeZone(when, zone, 'xxx')}`;
}

/**
 * The IANA zone the viewer's *browser* believes it is in. Used to decide
 * whether to show the "your browser is in X" reassurance note in SolarInfo.
 */
export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
