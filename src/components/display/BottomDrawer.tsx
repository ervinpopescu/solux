import { useState, type ReactNode } from 'react';
import styles from './BottomDrawer.module.css';

type Props = {
  children: ReactNode;
  /** Use the tighter mobile layout (smaller padding, lower max-height). */
  compact?: boolean;
  /** Start in the collapsed peek state. Useful on mobile so the map is
   *  immediately tappable; user expands when they want to see times. */
  startCollapsed?: boolean;
};

/**
 * Bottom-anchored slide-up panel.
 *
 * On desktop we default to open because there's plenty of screen for both
 * the map and the panel. On mobile (`startCollapsed`) we default to the
 * peek strip so the user can immediately tap anywhere on the map without
 * fighting the drawer for screen real estate.
 */
export default function BottomDrawer({ children, compact, startCollapsed }: Props) {
  const [open, setOpen] = useState(!startCollapsed);

  return (
    <section
      className={`${styles.drawer} ${open ? '' : styles.collapsed} ${compact ? styles.compact : ''}`}
      role="complementary"
      aria-label="Solar times for selected location"
      aria-expanded={open}
    >
      <button
        type="button"
        className={styles.handleRow}
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? 'Collapse panel' : 'Expand panel'}
        aria-expanded={open}
      >
        <span className={styles.handle} />
        <span className={styles.handleHint}>
          {open ? 'Tap to collapse' : 'Tap for solar times'}
        </span>
      </button>
      <div className={styles.body}>{children}</div>
    </section>
  );
}
