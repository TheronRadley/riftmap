/**
 * `npm run dev` - Vite dev server + Electron shell.
 *
 * Bundles main/preload with esbuild, starts Vite on 0.0.0.0:5173, waits for
 * the server to accept connections, then launches Electron pointed at it.
 * Requires the Electron binary (skipped installs will fail here and the
 * browser-only `npm run web` preview will still work).
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from './build-electron.mjs';

const require = createRequire(import.meta.url);
const packageRoot = new URL('../', import.meta.url).pathname;

const PORT = Number(process.env.PORT ?? 5173);
const HOST = '0.0.0.0';

await build();

const vite = spawn('npx', ['vite', '--host', HOST, '--port', String(PORT), '--strictPort'], {
  cwd: packageRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
});

const children = [vite];
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exit(code);
}

for (const child of children) {
  child.stdout?.on('data', (chunk) => process.stdout.write(`[vite] ${chunk}`));
  child.stderr?.on('data', (chunk) => process.stderr.write(`[vite] ${chunk}`));
  child.on('exit', (code) => {
    if (!shuttingDown) shutdown(code ?? 0);
  });
}

await waitForServer(`http://127.0.0.1:${PORT}/`);

let electronBinary;
try {
  electronBinary = require('electron');
} catch {
  console.error(
    '\nThe Electron binary is not installed (ELECTRON_SKIP_BINARY_DOWNLOAD=1 was set, or the download failed).\n' +
      'Run `npm install` with network access, or use `npm run web` for the browser preview.\n',
  );
  shutdown(1);
  throw new Error('electron not available');
}

const electron = spawn(electronBinary, ['.'], {
  cwd: packageRoot,
  stdio: 'inherit',
  env: { ...process.env, RIFTMAP_DEV_SERVER_URL: `http://127.0.0.1:${PORT}/` },
});
children.push(electron);
electron.on('exit', (code) => shutdown(code ?? 0));

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* server not up yet */
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Vite dev server did not start within ${timeoutMs} ms`);
}
