import { useCallback, useState } from 'react';
import type { TimeOfDayReading } from './useTimeOfDay';

type TimeSelection = {
  minutes: number;
  liveMinutes: number;
  minuteKey: number;
};

export function useLiveTimeSelection(
  liveTime: TimeOfDayReading,
): [number, (minutes: number) => void] {
  const [selection, setSelection] = useState<TimeSelection>(() => ({
    minutes: liveTime.minutes,
    liveMinutes: liveTime.minutes,
    minuteKey: liveTime.minuteKey,
  }));

  const isCurrent =
    selection.minuteKey === liveTime.minuteKey && selection.liveMinutes === liveTime.minutes;
  const minutes = isCurrent ? selection.minutes : liveTime.minutes;

  const selectMinutes = useCallback(
    (nextMinutes: number) => {
      setSelection({
        minutes: nextMinutes,
        liveMinutes: liveTime.minutes,
        minuteKey: liveTime.minuteKey,
      });
    },
    [liveTime.minuteKey, liveTime.minutes],
  );

  return [minutes, selectMinutes];
}
