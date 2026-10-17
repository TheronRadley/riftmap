import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { devApiPlugin } from './scripts/dev-api.mjs';

const packageRoot = new URL('./', import.meta.url).pathname;

export default defineConfig(({ command }) => ({
  root: packageRoot,
  base: './',
  plugins: [react(), ...(command === 'serve' ? [devApiPlugin()] : [])],
  // The `source` condition makes Vite consume the TypeScript sources of the
  // workspace packages directly, so there is no stale build step during
  // development. Node (Electron main) resolves the compiled `dist` output.
  resolve: {
    conditions: ['source', 'import', 'module', 'browser', 'default'],
    alias: {
      '@': resolve(packageRoot, 'src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: 'out/renderer',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    chunkSizeWarningLimit: 1600,
  },
}));
