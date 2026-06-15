import type { ReactNode } from 'react';
import styles from './MarkerPopup.module.css';

/**
 * Visual wrapper for the SolarInfo block when it's rendered inside Leaflet's
 * own popup bubble. We don't add layout chrome — Leaflet provides that —
 * we just hand the dark theme through.
 */
export default function MarkerPopup({ children }: { children: ReactNode }) {
  return <div className={styles.popup}>{children}</div>;
}
