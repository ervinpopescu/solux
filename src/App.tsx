// ==============================================================================
// Solux — App orchestration
// ==============================================================================
//
// Wires together persistent state, the map, the controls, and the four
// interchangeable display modes (floating card / bottom drawer / side panel /
// pin popup).
//
// Data flow:
//
//     map click → setPin → re-render
//       ├─ useTimezone(pin)  → IANA zone string
//       ├─ useSolarData(pin, date) → SolarTimes record
//       └─ <SolarInfo> formatted in `zone` via date-fns-tz
//          rendered inside the chosen display-mode wrapper
//
// Default date handling: if no date is persisted yet (first visit), we use
// today *in the pinned location's zone*. With no pin yet, we fall back to
// today in the browser's zone — this affects only the initial value of the
// date input until the user clicks the map.

import { useEffect, useMemo, useState } from 'react';
import { startOfDay } from 'date-fns';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import Controls from './components/Controls';
import SearchBox from './components/SearchBox';
import MapLibreView from './map/MapLibreView';
import SolarInfo from './components/SolarInfo';
import BottomDrawer from './components/display/BottomDrawer';
import FloatingCard from './components/display/FloatingCard';
import MarkerPopup from './components/display/MarkerPopup';
import SidePanel from './components/display/SidePanel';
import { useEffectiveSolarTimes } from './hooks/useEffectiveSolarTimes';
import { useHorizon } from './hooks/useHorizon';
import { useMediaQuery } from './hooks/useMediaQuery';
import { usePrefs } from './hooks/usePrefs';
import { useSolarData } from './hooks/useSolarData';
import { useTimezone } from './hooks/useTimezone';
import { useTimeOfDay } from './hooks/useTimeOfDay';
import { isoDateToNoonUtc } from './solar/calc';
import { sunExposureAt, type SunExposure } from './solar/exposure';
import { browserZone, isoDateInZone } from './util/zoneDate';
import appStyles from './App.module.css';

export default function App() {
  const { prefs, setPin, setDate, setDisplayMode } = usePrefs();
  const { pin, date } = prefs;

  // Mobile detection: under 640px we force the bottom drawer (the other
  // display modes leave too little of the screen for actually tapping the
  // map). The user's preference is preserved in storage and re-applies on
  // larger viewports.
  const isMobile = useMediaQuery('(max-width: 640px)');
  const displayMode = isMobile ? 'drawer' : prefs.displayMode;

  const zone = useTimezone(pin);

  // Live minutes in the pin's timezone; used as default for timeMinutes
  // and to show the live indicator dot on the slider.
  const liveMinutes = useTimeOfDay(pin ? zone : browserZone());

  // timeMinutes is initialised from liveMinutes and is kept in sync with the
  // 60-second tick via useEffect. Slider drags override it temporarily; the
  // next tick snaps it back to the real current time.
  const [timeMinutes, setTimeMinutes] = useState(liveMinutes);
  useEffect(() => {
    setTimeMinutes(liveMinutes);
  }, [liveMinutes]);

  // Resolve the effective date the rest of the app uses. Persisted empty
  // string → "today in the zone we currently know about". This is split
  // from `date` itself so the user can clear the picker and get sensible
  // behavior without us silently rewriting their preference.
  const effectiveDate = useMemo(() => {
    if (date) return date;
    return isoDateInZone(new Date(), pin ? zone : browserZone());
  }, [date, pin, zone]);

  // UTC instant of local midnight at the pin — the reference point for the arc
  // sample loop (minute 0 = local midnight).
  const dayStartUtc = useMemo<Date | null>(() => {
    if (!pin || !effectiveDate) return null;
    const noonUtc = isoDateToNoonUtc(effectiveDate);
    const localNoon = toZonedTime(noonUtc, zone);
    const localMidnight = startOfDay(localNoon);
    return fromZonedTime(localMidnight, zone);
  }, [effectiveDate, zone, pin]);

  // When the user has never set a date, mirror the computed "today" into
  // prefs so the date <input> reflects it. We deliberately only do this once
  // per session: subsequent zone changes don't overwrite an explicit choice.
  useEffect(() => {
    if (!date && effectiveDate) setDate(effectiveDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const solarTimes = useSolarData(pin, effectiveDate);
  const horizon = useHorizon(pin);

  // Live "is the pin in sun or building shadow right now?" status, recomputed
  // as the time slider moves. Uses the same horizon profile as the effective
  // times so the pin badge and the panel always agree.
  const exposure = useMemo<SunExposure | null>(() => {
    if (!pin || !dayStartUtc) return null;
    const instant = new Date(dayStartUtc.getTime() + timeMinutes * 60_000);
    return sunExposureAt(pin, instant, horizon.profile);
  }, [pin, dayStartUtc, timeMinutes, horizon.profile]);
  // When the building horizon is ready, recompute every sun-direct phase
  // against it. Twilight/blue-hour rows pass through unchanged.
  const effectiveTimes = useEffectiveSolarTimes(pin, solarTimes, horizon.profile);

  // The SolarInfo block is reused verbatim across all four display modes.
  const info = (
    <SolarInfo
      times={solarTimes}
      effective={effectiveTimes}
      zone={pin ? zone : browserZone()}
      latLng={pin}
      date={effectiveDate}
      horizon={horizon}
    />
  );

  // Pick the wrapper for the current display mode. `popup` is special: the
  // content is rendered *inside* the MapLibre marker popup rather than as an
  // overlay sibling of the map.
  const overlay = (() => {
    if (!pin) {
      // With no pin, default to a compact floating card (mobile: drawer)
      // showing the "click the map" prompt, regardless of the configured
      // mode. The empty state is informational only; mode kicks in after
      // the first click.
      return isMobile ? (
        <BottomDrawer compact startCollapsed>
          {info}
        </BottomDrawer>
      ) : (
        <FloatingCard>{info}</FloatingCard>
      );
    }
    switch (displayMode) {
      case 'card':
        return <FloatingCard>{info}</FloatingCard>;
      case 'drawer':
        return (
          <BottomDrawer compact={isMobile} startCollapsed={isMobile}>
            {info}
          </BottomDrawer>
        );
      case 'panel':
        return <SidePanel>{info}</SidePanel>;
      case 'popup':
        return null; // rendered inside the marker
    }
  })();

  const popupContent =
    pin && displayMode === 'popup' ? <MarkerPopup>{info}</MarkerPopup> : undefined;

  return (
    <>
      <MapLibreView
        pin={pin}
        onPin={setPin}
        popupContent={popupContent}
        solarTimes={solarTimes}
        dayStartUtc={dayStartUtc}
        timeMinutes={timeMinutes}
        exposure={exposure}
        buildings={horizon.buildings}
      />
      <div className={appStyles.topStack}>
        <Controls
          date={effectiveDate}
          onDateChange={setDate}
          displayMode={displayMode}
          onDisplayModeChange={setDisplayMode}
          pinZone={pin ? zone : browserZone()}
          hideDisplayMode={isMobile}
          timeMinutes={timeMinutes}
          onTimeMinutesChange={setTimeMinutes}
          liveMinutes={liveMinutes}
        />
        <SearchBox onPin={setPin} />
      </div>
      {overlay}
    </>
  );
}
