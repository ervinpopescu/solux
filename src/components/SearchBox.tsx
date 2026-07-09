// SearchBox queries Nominatim (OSM geocoder) and calls onPin with the chosen
// coordinate. The 600 ms debounce keeps us comfortably under Nominatim's
// 1 req/s policy for human-paced typing.

import { useCallback, useRef, useState } from 'react';
import type { LatLng } from '../types';
import styles from './SearchBox.module.css';

const GEO_SUPPORTED = typeof navigator !== 'undefined' && 'geolocation' in navigator;

type Hit = {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
};

type Props = { onPin: (latLng: LatLng) => void };

type GeoState = 'idle' | 'loading' | 'error';

export default function SearchBox({ onPin }: Props) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [geoState, setGeoState] = useState<GeoState>('idle');
  const geoErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const search = useCallback(async (q: string) => {
    if (q.trim().length < 3) {
      setHits([]);
      setOpen(false);
      return;
    }

    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setLoading(true);

    try {
      const url = new URL('https://nominatim.openstreetmap.org/search');
      url.searchParams.set('q', q);
      url.searchParams.set('format', 'json');
      url.searchParams.set('limit', '5');
      // Required by Nominatim usage policy for identification.
      // Value comes from VITE_NOMINATIM_CONTACT in .env (see .env.example).
      const contact = import.meta.env.VITE_NOMINATIM_CONTACT as string | undefined;
      if (contact) url.searchParams.set('email', contact);

      const res = await fetch(url.toString(), { signal: abortRef.current.signal });
      const data = (await res.json()) as Hit[];
      setHits(data);
      setOpen(data.length > 0);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setHits([]);
        setOpen(false);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const q = e.target.value;
    setQuery(q);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => search(q), 600);
  }

  function handleGeolocate() {
    if (!GEO_SUPPORTED || geoState === 'loading') return;
    setGeoState('loading');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeoState('idle');
        onPin({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        setGeoState('error');
        // Clear the error indicator after 3 s so the button is ready again.
        if (geoErrorTimerRef.current) clearTimeout(geoErrorTimerRef.current);
        geoErrorTimerRef.current = setTimeout(() => setGeoState('idle'), 3000);
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  function handleSelect(hit: Hit) {
    // Use the first part of the display name as a concise label in the input.
    setQuery(hit.display_name.split(',')[0].trim());
    setOpen(false);
    onPin({ lat: parseFloat(hit.lat), lng: parseFloat(hit.lon) });
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.inputWrap}>
        <input
          type="search"
          placeholder="Search location…"
          value={query}
          onChange={handleChange}
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          className={styles.input}
          aria-label="Search for a location"
          aria-autocomplete="list"
          aria-expanded={open}
        />
        {loading && <span className={styles.spinner} aria-hidden="true" />}
        {open && hits.length > 0 && (
          <ul className={styles.dropdown} role="listbox">
            {hits.map((hit) => (
              <li
                key={hit.place_id}
                role="option"
                aria-selected={false}
                className={styles.option}
                // onMouseDown fires before the input's onBlur, so the click
                // registers before the dropdown closes.
                onMouseDown={() => handleSelect(hit)}
              >
                {hit.display_name}
              </li>
            ))}
          </ul>
        )}
      </div>
      {GEO_SUPPORTED && (
        <button
          type="button"
          className={styles.geoBtn + (geoState === 'error' ? ' ' + styles.geoBtnError : '')}
          onClick={handleGeolocate}
          disabled={geoState === 'loading'}
          aria-label="Use my current location"
          title={
            geoState === 'error'
              ? 'Location unavailable — check browser permissions'
              : 'Use my current location'
          }
        >
          {geoState === 'loading' ? (
            <span className={styles.geoSpinner} aria-hidden="true" />
          ) : (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="7" />
              <line x1="12" y1="2" x2="12" y2="5" />
              <line x1="12" y1="19" x2="12" y2="22" />
              <line x1="2" y1="12" x2="5" y2="12" />
              <line x1="19" y1="12" x2="22" y2="12" />
            </svg>
          )}
        </button>
      )}
    </div>
  );
}
