/**
 * Dev-only analysis backend for the browser preview.
 *
 * `npm run dev:web` runs the renderer in a plain Vite dev server with no
 * Electron main process. To keep that preview honest - real files, real Git,
 * real Zig engine, no fabricated data - this Vite plugin exposes the same
 * IPC-shaped operations over HTTP from Node.
 *
 * It is registered only by `vite.config.ts` when `serve` mode is active; the
 * production build ships none of it.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = new URL('../../../', import.meta.url).pathname;

async function loadAnalysis() {
  // The built ESM output of packages/analysis (see `npm run typecheck`).
  return await import(`${repoRoot}packages/analysis/dist/index.js`);
}

/**
 * @returns {import('vite').Plugin}
 */
export function devApiPlugin() {
  /** @type {Map<string, {progress: any[], done: boolean, result: any}>} */
  const jobs = new Map();
  /** @type {Map<string, AbortController>} */
  const controllers = new Map();
  let analysisModulePromise = null;
  let gitModulePromise = null;

  const getAnalysis = () => {
    analysisModulePromise ??= loadAnalysis();
    return analysisModulePromise;
  };
  const getGit = () => {
    gitModulePromise ??= import(`${repoRoot}packages/git-analysis/dist/index.js`);
    return gitModulePromise;
  };

  const json = (res, status, body) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };

  return {
    name: 'riftmap-dev-api',
    configureServer(server) {
      server.middlewares.use('/__api/app-info', async (_req, res) => {
        try {
          const [{ resolveEnginePath }, git] = [await getAnalysis(), await getGit()];
          let engine = { path: null, version: null, ok: false, message: 'not found' };
          try {
            const path = resolveEnginePath();
            engine = { path, version: 'riftmap-engine', ok: true, message: 'ready' };
          } catch (error) {
            engine = { path: null, version: null, ok: false, message: String(error) };
          }
          json(res, 200, {
            appVersion: '0.1.0 (web preview)',
            electronVersion: 'n/a',
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            engine,
            gitVersion: await git.detectGitVersion(),
            webPreview: true,
          });
        } catch (error) {
          json(res, 500, { error: String(error) });
        }
      });

      server.middlewares.use('/__api/analyze', async (req, res) => {
        if (req.method !== 'POST') {
          json(res, 405, { error: 'POST required' });
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        let request;
        try {
          request = JSON.parse(body || '{}');
        } catch {
          json(res, 400, { ok: false, code: 'invalid-request', message: 'Malformed request.' });
          return;
        }

        const runId = request.runId || `run-${Date.now()}`;
        jobs.set(runId, { progress: [], done: false, result: null });
        const controller = new AbortController();
        controllers.set(runId, controller);

        json(res, 200, { runId });

        // Fire and forget: the client follows the event stream.
        queueMicrotask(async () => {
          const analysis = await getAnalysis();
          const job = jobs.get(runId);
          if (!job) return;
          try {
            const result = await analysis.analyzeRepository({
              repoPath: request.repoPath,
              historyWindowDays: request.historyWindowDays ?? 'all',
              signal: controller.signal,
              ...(request.maxFileBytes ? { maxFileBytes: request.maxFileBytes } : {}),
              ...(request.maxFiles ? { maxFiles: request.maxFiles } : {}),
              ...(request.maxDepth ? { maxDepth: request.maxDepth } : {}),
              ...(request.largeFileMode ? { largeFileMode: request.largeFileMode } : {}),
              ...(typeof request.includeHidden === 'boolean' ? { includeHidden: request.includeHidden } : {}),
              ...(typeof request.useGitignore === 'boolean' ? { useGitignore: request.useGitignore } : {}),
              ...(Array.isArray(request.extraIgnore) ? { extraIgnore: request.extraIgnore } : {}),
              ...(request.maxCommits ? { maxCommits: request.maxCommits } : {}),
              onProgress: (progress) => {
                job.progress.push({ ...progress, runId });
              },
            });
            job.result = { ok: true, analysis: result };
          } catch (error) {
            job.result = {
              ok: false,
              code: error?.code ?? 'unknown',
              message: error?.message ?? String(error),
              ...(error?.stderr ? { stderr: String(error.stderr).slice(-4000) } : {}),
            };
          }
          job.done = true;
          controllers.delete(runId);
          setTimeout(() => jobs.delete(runId), 60_000);
        });
      });

      server.middlewares.use('/__api/cancel', async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const runId = url.searchParams.get('runId');
        const controller = runId ? controllers.get(runId) : undefined;
        if (controller) controller.abort();
        json(res, 200, { canceled: Boolean(controller) });
      });

      server.middlewares.use('/__api/events', async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const runId = url.searchParams.get('runId') ?? '';
        const job = jobs.get(runId);
        if (!job) {
          json(res, 404, { error: 'unknown run' });
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();

        let cursor = 0;
        const timer = setInterval(() => {
          while (cursor < job.progress.length) {
            const event = job.progress[cursor];
            cursor += 1;
            res.write(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);
          }
          if (job.done) {
            res.write(`event: done\ndata: ${JSON.stringify(job.result)}\n\n`);
            clearInterval(timer);
            res.end();
          }
        }, 100);

        req.on('close', () => clearInterval(timer));
      });

      server.middlewares.use('/__api/preview', async (req, res) => {
        if (req.method !== 'POST') {
          json(res, 405, { error: 'POST required' });
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        let request = {};
        try {
          request = JSON.parse(body || '{}');
        } catch {
          json(res, 400, { ok: false, code: 'invalid-path', message: 'Malformed request.' });
          return;
        }

        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const LIMIT = 512 * 1024;
        const root = path.resolve(String(request.repoPath ?? ''));
        const rel = path.normalize(String(request.relativePath ?? '')).replace(/\\/g, '/');
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
          json(res, 200, { ok: false, code: 'outside-repository', message: 'Refusing to read outside the repository.' });
          return;
        }
        const target = path.join(root, rel);
        if (!path.resolve(target).startsWith(root + path.sep)) {
          json(res, 200, { ok: false, code: 'outside-repository', message: 'Refusing to read outside the repository.' });
          return;
        }
        try {
          const info = await fs.stat(target);
          if (!info.isFile()) {
            json(res, 200, { ok: false, code: 'not-a-file', message: 'That path is not a file.' });
            return;
          }
          if (info.size > LIMIT * 4) {
            json(res, 200, { ok: false, code: 'too-large', message: `File is ${info.size} bytes; preview limit is ${LIMIT} bytes.` });
            return;
          }
          const buffer = await fs.readFile(target);
          const slice = buffer.subarray(0, LIMIT);
          if (slice.includes(0)) {
            json(res, 200, { ok: false, code: 'binary', message: 'That file looks like binary content.' });
            return;
          }
          let text = slice.toString('utf8');
          if (buffer.length > LIMIT) {
            text += `\n\n… truncated: showing ${LIMIT} of ${buffer.length} bytes.`;
          }
          const lines = text.split('\n');
          const limited = lines.length > 4000;
          if (limited) text = lines.slice(0, 4000).join('\n');
          json(res, 200, {
            ok: true,
            path: rel,
            content: text,
            bytes: buffer.length,
            truncated: buffer.length > LIMIT,
            note: limited ? 'Preview limited to the first 4000 lines.' : null,
          });
        } catch {
          json(res, 200, { ok: false, code: 'not-found', message: 'That file could not be read.' });
        }
      });
    },
  };
}
