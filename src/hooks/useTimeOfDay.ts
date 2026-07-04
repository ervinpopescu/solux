import { useState, useEffect } from 'react';
import { toZonedTime } from 'date-fns-tz';

function nowMinutes(zone: string): number {
  const zoned = toZonedTime(new Date(), zone);
  return zoned.getHours() * 60 + zoned.getMinutes();
}

/** Returns minutes since midnight (0–1439) in `zone`, refreshing every 60 s. */
export function useTimeOfDay(zone: string): number {
  const [minutes, setMinutes] = useState(() => nowMinutes(zone));

  useEffect(() => {
    setMinutes(nowMinutes(zone));
    const id = setInterval(() => setMinutes(nowMinutes(zone)), 60_000);
    return () => clearInterval(id);
  }, [zone]);

  return minutes;
}
