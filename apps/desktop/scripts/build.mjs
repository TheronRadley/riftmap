/**
 * `npm run build` - bundles the renderer with Vite and the Electron side with
 * esbuild, producing:
 *
 *   apps/desktop/out/renderer/   static renderer bundle
 *   apps/desktop/out/main/       bundled main process
 *   apps/desktop/out/preload/    bundled preload bridge
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';

const packageRoot = new URL('../', import.meta.url).pathname;
const repoRoot = new URL('../../../', import.meta.url).pathname;

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: packageRoot, stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise(undefined);
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}

await run('npx', ['vite', 'build']);
await import('./build-electron.mjs');

// Ship the compiled native engine next to the app when it has been built.
const engineCandidates = [`${repoRoot}engine/zig-out/bin/riftmap-engine`, `${repoRoot}engine/zig-out/bin/riftmap-engine.exe`];
mkdirSync(`${packageRoot}out/engine`, { recursive: true });
let copied = false;
for (const candidate of engineCandidates) {
  if (existsSync(candidate)) {
    copyFileSync(candidate, `${packageRoot}out/engine/${candidate.split('/').pop()}`);
    copied = true;
  }
}
if (!copied) {
  console.warn('! engine/zig-out/bin/riftmap-engine not found - run `npm run engine:build` before packaging.');
}
