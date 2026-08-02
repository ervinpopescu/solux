import { useMemo, useSyncExternalStore } from 'react';
import { toZonedTime } from 'date-fns-tz';

export type TimeOfDayReading = {
  minutes: number;
  minuteKey: number;
};

function currentMinuteKey(): number {
  return Math.floor(Date.now() / 60_000);
}

function subscribeToClock(onChange: () => void): () => void {
  const id = setInterval(onChange, 60_000);
  return () => clearInterval(id);
}

function minutesInZone(zone: string, minuteKey: number): number {
  const zoned = toZonedTime(new Date(minuteKey * 60_000), zone);
  return zoned.getHours() * 60 + zoned.getMinutes();
}

export function useTimeOfDayReading(zone: string): TimeOfDayReading {
  const minuteKey = useSyncExternalStore(subscribeToClock, currentMinuteKey, currentMinuteKey);

  return useMemo(() => ({ minutes: minutesInZone(zone, minuteKey), minuteKey }), [zone, minuteKey]);
}

/** Returns minutes since midnight (0-1439) in `zone`, refreshing every 60 s. */
export function useTimeOfDay(zone: string): number {
  return useTimeOfDayReading(zone).minutes;
}
