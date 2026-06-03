import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: Vite on :5173 proxies API + WS to the backend on :8099.
// Build: emits to ../web/dist, which the backend serves in prod.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8099', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8099', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
