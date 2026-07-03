import { useState, useEffect } from 'react';
import { toZonedTime } from 'date-fns-tz';

/** Returns minutes since midnight (0–1439) in `zone`, refreshing every 60 s. */
export function useTimeOfDay(zone: string): number {
  function nowMinutes(): number {
    const zoned = toZonedTime(new Date(), zone);
    return zoned.getHours() * 60 + zoned.getMinutes();
  }

  const [minutes, setMinutes] = useState(nowMinutes);

  useEffect(() => {
    setMinutes(nowMinutes());
    const id = setInterval(() => setMinutes(nowMinutes()), 60_000);
    return () => clearInterval(id);
  }, [zone]);

  return minutes;
}
