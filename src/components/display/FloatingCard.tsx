import type { ReactNode } from 'react';
import styles from './FloatingCard.module.css';

export default function FloatingCard({ children }: { children: ReactNode }) {
  return (
    <aside
      className={styles.card}
      role="complementary"
      aria-label="Solar times for selected location"
    >
      {children}
    </aside>
  );
}
