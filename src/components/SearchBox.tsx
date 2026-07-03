// SearchBox queries Nominatim (OSM geocoder) and calls onPin with the chosen
// coordinate. The 600 ms debounce keeps us comfortably under Nominatim's
// 1 req/s policy for human-paced typing.

import { useCallback, useRef, useState } from 'react';
import type { LatLng } from '../types';
import styles from './SearchBox.module.css';

type Hit = {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
};

type Props = { onPin: (latLng: LatLng) => void };

export default function SearchBox({ onPin }: Props) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

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

  function handleSelect(hit: Hit) {
    // Use the first part of the display name as a concise label in the input.
    setQuery(hit.display_name.split(',')[0].trim());
    setOpen(false);
    onPin({ lat: parseFloat(hit.lat), lng: parseFloat(hit.lon) });
  }

  return (
    <div className={styles.wrap}>
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
  );
}
