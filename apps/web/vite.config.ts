import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Phase 0 keeps the Vite config bare. The canvas migration in Phase 3 wires
// react-force-graph + WebSocket subscribers and adds the proxy entries needed
// to talk to the API in dev.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL ?? 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
