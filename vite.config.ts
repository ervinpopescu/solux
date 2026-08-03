import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png'],
      manifest: {
        name: 'Solux - Golden Hour Map',
        short_name: 'Solux',
        description: 'Golden hour and sun phase map for photographers.',
        theme_color: '#0b0d12', // Matches our dark mode bg
        background_color: '#0b0d12',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          // Since we don't have explicit PWA icons, we will just declare standard ones
          // to be generated or placed in public/ later.
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        // Cache MapLibre GL JS requests if needed, though they handle their own tiles.
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
      },
      devOptions: {
        enabled: true,
        type: 'module',
      },
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    allowedHosts: true, // Allow all hosts to fix the Tailscale wildcard issue
    hmr: {
      host: 'aslan.home.ro',
      protocol: process.env.VITE_HMR_PROTOCOL || 'ws',
    },
  },
});
