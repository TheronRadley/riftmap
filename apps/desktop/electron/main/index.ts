/**
 * Riftmap main process.
 *
 * Responsibilities, and only these:
 *  - create a hardened BrowserWindow (no node integration, sandbox on,
 *    context isolation on);
 *  - show the native folder picker;
 *  - run the analysis pipeline (Zig engine + Git) and stream progress;
 *  - serve bounded, read-only file previews for the inspector.
 *
 * Everything the renderer can ask for goes through a validated IPC handler.
 * There is no generic filesystem channel and no shell execution channel.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import {
  analyzeRepository,
  EngineError,
  resolveEnginePath,
  type AnalyzeRepositoryOptions,
} from '@riftmap/analysis';
import type { AnalysisProgress } from '@riftmap/analysis';
import { detectGitVersion } from '@riftmap/git-analysis';
import type {
  AnalyzeRequest,
  AnalyzeResult,
  AppInfo,
  FilePreviewRequest,
  FilePreviewResult,
  PickFolderResult,
} from '../../shared/ipc.js';
import { IPC } from '../../shared/ipc.js';

const PREVIEW_LIMIT_BYTES = 512 * 1024;
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
const PREVIEW_LINE_LIMIT = 4000;

const activeRuns = new Map<string, AbortController>();

let cachedEngineInfo: AppInfo['engine'] | null = null;
let engineInfoPromise: Promise<AppInfo['engine'] | null> | null = null;

const DEV_SERVER_URL = process.env.RIFTMAP_DEV_SERVER_URL ?? '';

function engineInfo(): Promise<AppInfo['engine'] | null> {
  if (cachedEngineInfo) return Promise.resolve(cachedEngineInfo);
  if (!engineInfoPromise) {
    engineInfoPromise = (async () => {
      try {
        const path = resolveEnginePath();
        const exit = await runEngineVersion(path);
        if (exit.code === 0) {
          const first = exit.stdout.split('\n').find((line) => line.trim().length > 0) ?? '';
          const info = { path, version: first.trim(), ok: true, message: 'ready' };
          cachedEngineInfo = info;
          return info;
        }
        const info = {
          path,
          version: null,
          ok: false,
          message: `The engine exited with code ${exit.code}: ${exit.stderr.trim() || exit.stdout.trim() || 'no output'}`,
        };
        cachedEngineInfo = info;
        return info;
      } catch (error) {
        const info = {
          path: null,
          version: null,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
        cachedEngineInfo = info;
        return info;
      }
    })();
  }
  return engineInfoPromise;
}

function runEngineVersion(path: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const child = spawn(path, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolvePromise({ code, stdout, stderr });
    };
    child.on('error', () => done(null));
    child.on('close', done);
  });
}

/** Resolves a repository-relative path, refusing anything that escapes the root. */
function safeJoin(repoRoot: string, relativePath: string): string | null {
  if (!relativePath || relativePath.length === 0) return null;
  if (isAbsolute(relativePath)) return null;
  // Normalise first so `../..` cannot smuggle its way out.
  const normalised = normalize(relativePath).replace(/\\/g, '/');
  if (normalised === '..' || normalised.startsWith('../')) return null;
  const target = resolve(repoRoot, normalised);
  const rel = relative(resolve(repoRoot), target);
  if (rel === '') return null;
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return target;
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#14161a',
    show: false,
    title: 'Riftmap',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(app.getAppPath(), 'out', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  // Navigation is locked to what Riftmap itself loads.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    const isLocal = url.startsWith('file://') || (DEV_SERVER_URL && url.startsWith(DEV_SERVER_URL));
    if (!isLocal) {
      event.preventDefault();
    }
  });

  window.once('ready-to-show', () => window.show());

  if (DEV_SERVER_URL) {
    void window.loadURL(DEV_SERVER_URL);
  } else {
    void window.loadFile(join(app.getAppPath(), 'out', 'renderer', 'index.html'));
  }

  return window;
}

function registerHandlers(): void {
  ipcMain.handle(IPC.appInfo, async (): Promise<AppInfo> => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? 'n/a',
    nodeVersion: process.versions.node ?? 'n/a',
    platform: process.platform,
    arch: process.arch,
    engine: await engineInfo(),
    gitVersion: await detectGitVersion(),
    webPreview: false,
  }));

  ipcMain.handle(IPC.pickFolder, async (event): Promise<PickFolderResult> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return { canceled: true, path: null };
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a repository folder',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Analyse',
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true, path: null };
    return { canceled: false, path: result.filePaths[0] ?? null };
  });

  ipcMain.handle(IPC.analyze, async (event, raw: unknown): Promise<AnalyzeResult> => {
    const parsed = parseAnalyzeRequest(raw);
    if ('error' in parsed) {
      return { ok: false, code: 'invalid-request', message: parsed.error };
    }
    const request = parsed.request;

    // The renderer may only analyse a real directory on disk.
    try {
      const info = await stat(request.repoPath);
      if (!info.isDirectory()) {
        return { ok: false, code: 'path-not-directory', message: 'That path is not a directory.' };
      }
    } catch {
      return {
        ok: false,
        code: 'path-not-found',
        message: 'That folder does not exist or cannot be opened.',
        hint: 'Pick the root folder of a local Git repository.',
      };
    }

    const controller = new AbortController();
    activeRuns.set(request.runId, controller);

    const options: AnalyzeRepositoryOptions = {
      repoPath: request.repoPath,
      historyWindowDays: request.historyWindowDays,
      signal: controller.signal,
      onProgress: (progress: AnalysisProgress) => {
        if (event.sender.isDestroyed()) return;
        event.sender.send(IPC.progress, { ...progress, runId: request.runId });
      },
    };
    if (request.maxFileBytes !== undefined) options.maxFileBytes = request.maxFileBytes;
    if (request.maxFiles !== undefined) options.maxFiles = request.maxFiles;
    if (request.maxDepth !== undefined) options.maxDepth = request.maxDepth;
    if (request.largeFileMode !== undefined) options.largeFileMode = request.largeFileMode;
    if (request.includeHidden !== undefined) options.includeHidden = request.includeHidden;
    if (request.useGitignore !== undefined) options.useGitignore = request.useGitignore;
    if (request.extraIgnore !== undefined) options.extraIgnore = request.extraIgnore;
    if (request.timeoutMs !== undefined) options.timeoutMs = request.timeoutMs;
    if (request.maxCommits !== undefined) options.maxCommits = request.maxCommits;

    try {
      const analysis = await analyzeRepository(options);
      return { ok: true, analysis };
    } catch (error) {
      if (controller.signal.aborted) {
        return { ok: false, code: 'cancelled', message: 'Analysis cancelled.' };
      }
      if (error instanceof EngineError) {
        const hint =
          error.code === 'engine-not-found'
            ? 'Run `npm run engine:build` to compile the Zig engine, or set RIFTMAP_ENGINE_PATH.'
            : error.code === 'engine-timeout'
              ? 'Try a smaller folder, or raise the timeout in Settings.'
              : undefined;
        return {
          ok: false,
          code: error.code as AnalyzeResult extends { code: infer C } ? C : never,
          message: error.message,
          ...(hint ? { hint } : {}),
          ...(error.stderrTail ? { stderr: error.stderrTail.slice(-4000) } : {}),
        };
      }
      return {
        ok: false,
        code: 'unknown',
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      activeRuns.delete(request.runId);
    }
  });

  ipcMain.handle(IPC.cancel, (_event, runId: unknown): boolean => {
    if (typeof runId !== 'string') return false;
    const controller = activeRuns.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  });

  ipcMain.handle(IPC.readPreview, async (_event, raw: unknown): Promise<FilePreviewResult> => {
    const request = parsePreviewRequest(raw);
    if ('error' in request) return { ok: false, code: 'invalid-path', message: request.error };
    const { repoPath, relativePath, maxBytes } = request.value;

    const target = safeJoin(repoPath, relativePath);
    if (!target) {
      return { ok: false, code: 'outside-repository', message: 'Refusing to read a path outside the repository.' };
    }

    let info;
    try {
      info = await stat(target);
    } catch {
      return { ok: false, code: 'not-found', message: 'That file no longer exists.' };
    }
    if (!info.isFile()) return { ok: false, code: 'not-a-file', message: 'That path is not a file.' };

    const limit = Math.min(maxBytes ?? PREVIEW_LIMIT_BYTES, MAX_PREVIEW_BYTES);
    if (info.size > limit * 4) {
      return {
        ok: false,
        code: 'too-large',
        message: `This file is ${info.size} bytes. Riftmap previews the first ${limit} bytes only, and this file is too large to preview safely.`,
      };
    }

    // Read with node:fs, never execute, never evaluate.
    const { readFile } = await import('node:fs/promises');
    let buffer: Buffer;
    try {
      buffer = await readFile(target);
    } catch (error) {
      return {
        ok: false,
        code: 'read-failed',
        message: error instanceof Error ? error.message : 'The file could not be read.',
      };
    }

    const slice = buffer.subarray(0, limit);
    // Refuse to render likely-binary content (NUL bytes in the first chunk).
    if (slice.includes(0)) {
      return { ok: false, code: 'binary', message: 'That file looks like binary content and is not previewed.' };
    }

    let text = slice.toString('utf8');
    let note: string | null = null;
    if (buffer.length > limit) {
      text = `${text}\n\n… truncated: showing ${limit} of ${buffer.length} bytes.`;
      note = `Preview limited to the first ${limit} bytes.`;
    }
    const lines = text.split('\n');
    if (lines.length > PREVIEW_LINE_LIMIT) {
      text = lines.slice(0, PREVIEW_LINE_LIMIT).join('\n');
      note = `Preview limited to the first ${PREVIEW_LINE_LIMIT} lines.`;
    }

    return {
      ok: true,
      path: relativePath,
      content: text,
      bytes: buffer.length,
      truncated: buffer.length > limit,
      note,
    };
  });
}

function parseAnalyzeRequest(raw: unknown): { request: AnalyzeRequest } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'Malformed analysis request.' };
  const value = raw as Partial<AnalyzeRequest>;
  if (typeof value.repoPath !== 'string' || value.repoPath.trim() === '') {
    return { error: 'A repository path is required.' };
  }
  if (isAbsolute(value.repoPath) === false) {
    return { error: 'The repository path must be absolute.' };
  }
  const window = value.historyWindowDays;
  if (window !== 30 && window !== 90 && window !== 180 && window !== 'all') {
    return { error: 'Unsupported history window.' };
  }
  const runId = typeof value.runId === 'string' && value.runId.length > 0 ? value.runId : randomUUID();
  const request: AnalyzeRequest = { runId, repoPath: value.repoPath, historyWindowDays: window };
  if (typeof value.maxFileBytes === 'number' && Number.isFinite(value.maxFileBytes)) request.maxFileBytes = value.maxFileBytes;
  if (typeof value.maxFiles === 'number' && Number.isFinite(value.maxFiles)) request.maxFiles = value.maxFiles;
  if (typeof value.maxDepth === 'number' && Number.isFinite(value.maxDepth)) request.maxDepth = value.maxDepth;
  if (value.largeFileMode === 'skip' || value.largeFileMode === 'count_lines' || value.largeFileMode === 'full') {
    request.largeFileMode = value.largeFileMode;
  }
  if (typeof value.includeHidden === 'boolean') request.includeHidden = value.includeHidden;
  if (typeof value.useGitignore === 'boolean') request.useGitignore = value.useGitignore;
  if (Array.isArray(value.extraIgnore)) {
    request.extraIgnore = value.extraIgnore.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value.timeoutMs === 'number' && Number.isFinite(value.timeoutMs)) request.timeoutMs = value.timeoutMs;
  if (typeof value.maxCommits === 'number' && Number.isFinite(value.maxCommits)) request.maxCommits = value.maxCommits;
  return { request };
}

function parsePreviewRequest(
  raw: unknown,
): { value: FilePreviewRequest } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'Malformed preview request.' };
  const value = raw as Partial<FilePreviewRequest>;
  if (typeof value.repoPath !== 'string' || value.repoPath === '') return { error: 'A repository path is required.' };
  if (typeof value.relativePath !== 'string' || value.relativePath === '') return { error: 'A file path is required.' };
  const request: FilePreviewRequest = { repoPath: value.repoPath, relativePath: value.relativePath };
  if (typeof value.maxBytes === 'number' && Number.isFinite(value.maxBytes)) request.maxBytes = value.maxBytes;
  return { value: request };
}

function bootstrap(): void {
  // No telemetry, no crash reporting, no outbound requests.
  app.setName('Riftmap');

  app.whenReady().then(() => {
    registerHandlers();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  // External links (licences, docs) open in the user's browser, never inside
  // the app shell.
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler((details) => {
      if (details.url.startsWith('https://')) {
        void shell.openExternal(details.url);
      }
      return { action: 'deny' };
    });
  });
}

bootstrap();
