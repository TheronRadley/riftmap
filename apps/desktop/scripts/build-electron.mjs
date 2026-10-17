/**
 * Bundles the Electron main process and preload script with esbuild.
 *
 * Both are plain Node-side bundles: `electron` is external, everything else is
 * inlined so the packaged app does not depend on node_modules at runtime.
 */

import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageRoot = new URL('../', import.meta.url).pathname;

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  external: ['electron', 'node:*'],
  sourcemap: true,
  logLevel: 'info',
  // Node resolves the workspace packages through their compiled `dist` output.
  conditions: ['import', 'module', 'default'],
  absWorkingDir: packageRoot,
};

rmSync(new URL('../out/main/', import.meta.url).pathname, { recursive: true, force: true });
rmSync(new URL('../out/preload/', import.meta.url).pathname, { recursive: true, force: true });

await build({
  ...shared,
  entryPoints: ['electron/main/index.ts'],
  outfile: 'out/main/index.js',
});

await build({
  ...shared,
  // The preload runs in a sandboxed renderer context, so it must be CJS.
  format: 'cjs',
  entryPoints: ['electron/preload/index.ts'],
  outfile: 'out/preload/index.js',
});

void require;
