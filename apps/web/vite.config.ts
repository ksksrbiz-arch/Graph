import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `@pkg/shared` is a workspace package built to CommonJS (dist/index.js uses
// tslib `__exportStar`). pnpm symlinks it under node_modules but rollup
// resolves the realpath into `packages/shared`, so it falls outside the
// commonjs plugin's default `node_modules` include — runtime named imports
// (e.g. colorForNodeType) then fail at build time. Widen the include + force
// pre-bundling so the canvas can import shared values, not just types.
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
  optimizeDeps: {
    include: ['@pkg/shared'],
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    commonjsOptions: {
      include: [/node_modules/, /packages\/shared/],
      transformMixedEsModules: true,
    },
  },
});
