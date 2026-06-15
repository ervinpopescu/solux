import type { ReactNode } from 'react';
import styles from './SidePanel.module.css';

export default function SidePanel({ children }: { children: ReactNode }) {
  return (
    <aside
      className={styles.panel}
      role="complementary"
      aria-label="Solar times for selected location"
    >
      {children}
    </aside>
  );
}
