import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    allowedHosts: ['aslan.home.ro', 'lauras-macbook-pro-2.tail6677f3.ts.net'],
    hmr: {
      host: 'aslan.home.ro',
      protocol: 'ws',
    },
  },
});
