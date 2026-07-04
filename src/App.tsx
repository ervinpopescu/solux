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

import { useEffect, useMemo } from 'react';
import Controls from './components/Controls';
import MapView from './components/MapView';
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
import { browserZone, isoDateInZone } from './util/zoneDate';

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

  // Resolve the effective date the rest of the app uses. Persisted empty
  // string → "today in the zone we currently know about". This is split
  // from `date` itself so the user can clear the picker and get sensible
  // behavior without us silently rewriting their preference.
  const effectiveDate = useMemo(() => {
    if (date) return date;
    return isoDateInZone(new Date(), pin ? zone : browserZone());
  }, [date, pin, zone]);

  // When the user has never set a date, mirror the computed "today" into
  // prefs so the date <input> reflects it. We deliberately only do this once
  // per session: subsequent zone changes don't overwrite an explicit choice.
  useEffect(() => {
    if (!date && effectiveDate) setDate(effectiveDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const solarTimes = useSolarData(pin, effectiveDate);
  const horizon = useHorizon(pin);
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
  // content is rendered *inside* the Leaflet marker popup rather than as an
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
      <MapView pin={pin} onPin={setPin} popupContent={popupContent} />
      <Controls
        date={effectiveDate}
        onDateChange={setDate}
        displayMode={displayMode}
        onDisplayModeChange={setDisplayMode}
        pinZone={pin ? zone : browserZone()}
        hideDisplayMode={isMobile}
      />
      {overlay}
    </>
  );
}
