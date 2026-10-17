/**
 * Spawns the native Zig analysis engine and validates its output.
 *
 * The engine is an ordinary child process: stdout carries exactly one JSON
 * document, stderr carries progress events and diagnostics. Every failure mode
 * the platform can produce is mapped onto a typed error so the UI can explain
 * what happened instead of showing a blank screen.
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  parseEngineDocument,
  ValidationError,
  type EngineDocument,
  type EngineProgressEvent,
} from '@riftmap/shared';

export type EngineErrorCode =
  | 'engine-not-found'
  | 'engine-not-executable'
  | 'engine-spawn-failed'
  | 'engine-cancelled'
  | 'engine-timeout'
  | 'engine-exit'
  | 'engine-invalid-json'
  | 'engine-schema';

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly detail?: string;
  readonly stderrTail?: string;

  constructor(code: EngineErrorCode, message: string, detail?: string, stderrTail?: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.detail = detail;
    this.stderrTail = stderrTail;
  }
}

export interface EngineRunOptions {
  repoPath: string;
  enginePath?: string;
  maxFileBytes?: number;
  maxFiles?: number;
  maxDepth?: number;
  maxTotalBytes?: number;
  largeFileMode?: 'skip' | 'count_lines' | 'full';
  includeHidden?: boolean;
  useGitignore?: boolean;
  extractImports?: boolean;
  computeComplexity?: boolean;
  extraIgnore?: string[];
  /** Output JSON to a file instead of stdout (used by the benchmark harness). */
  outFile?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (event: EngineProgressEvent) => void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export async function runEngine(options: EngineRunOptions): Promise<EngineDocument> {
  const enginePath = resolveEnginePath(options.enginePath);
  const args = buildArgs(options);
  const child = spawn(enginePath, args, {
    cwd: dirname(enginePath),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  return new Promise<EngineDocument>((promiseResolve, promiseReject) => {
    let settled = false;
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const abort = () => child.kill('SIGKILL');
    if (options.signal) {
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      // 512 MiB guard: a legitimate scan never approaches this.
      if (stdoutBytes <= 512 * 1024 * 1024) stdoutChunks.push(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrTail = (stderrTail + text).slice(-8000);
      if (options.onProgress) {
        for (const line of text.split('\n')) {
          const event = tryParseProgress(line);
          if (event) options.onProgress(event);
        }
      }
    });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      fn();
    };

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(() => {
        if (error.code === 'ENOENT') {
          promiseReject(
            new EngineError(
              'engine-not-found',
              'The analysis engine executable could not be found.',
              `Expected at ${enginePath}. Run "npm run engine:build" to compile it.`,
            ),
          );
        } else if (error.code === 'EACCES') {
          promiseReject(
            new EngineError('engine-not-executable', 'The analysis engine is not executable.', enginePath, stderrTail),
          );
        } else {
          promiseReject(new EngineError('engine-spawn-failed', `Could not start the engine: ${error.message}`, enginePath, stderrTail));
        }
      });
    });

    child.on('close', (code, signal) => {
      finish(() => {
        const tail = stderrTail.trim().slice(-2000);
        if (options.signal?.aborted) {
          promiseReject(new EngineError('engine-cancelled', 'The scan was cancelled.', undefined, tail));
          return;
        }
        if (timedOut) {
          promiseReject(
            new EngineError(
              'engine-timeout',
              `The scan exceeded the ${Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s time limit.`,
              'Try raising the limit or excluding large directories with a .riftmapignore file.',
              tail,
            ),
          );
          return;
        }
        // Exit code 3 means "completed but truncated by a safety limit".
        if (code !== 0 && code !== 3) {
          const fatal = tryParseFatal(stderrTail);
          promiseReject(
            new EngineError(
              'engine-exit',
              fatal ?? `The analysis engine exited with code ${code ?? signal}.`,
              tail,
              tail,
            ),
          );
          return;
        }

        const raw = Buffer.concat(stdoutChunks).toString('utf8');
        if (!raw.trim()) {
          promiseReject(
            new EngineError(
              'engine-invalid-json',
              'The analysis engine produced no output.',
              'This usually means the engine crashed. Its diagnostic output is shown below.',
              tail,
            ),
          );
          return;
        }

        try {
          promiseResolve(parseEngineDocument(raw));
        } catch (error) {
          if (error instanceof ValidationError) {
            promiseReject(
              new EngineError(
                error.path.includes('schemaVersion') ? 'engine-schema' : 'engine-invalid-json',
                'The engine produced data this version of Riftmap cannot read.',
                error.message,
                tail,
              ),
            );
            return;
          }
          promiseReject(new EngineError('engine-invalid-json', 'Could not read the engine output.', String(error), tail));
        }
      });
    });
  });
}

function tryParseProgress(line: string): EngineProgressEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'object' && parsed !== null && (parsed as { type?: string }).type === 'progress') {
      return parsed as EngineProgressEvent;
    }
  } catch {
    // Ignore partial or non-JSON diagnostic lines.
  }
  return null;
}

function tryParseFatal(stderr: string): string | null {
  for (const line of stderr.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as { type?: string; code?: string; message?: string };
      if (parsed.type === 'fatal') {
        return `The analysis engine failed (${parsed.code ?? 'unknown'})${parsed.message ? `: ${parsed.message}` : ''}.`;
      }
    } catch {
      // Ignore.
    }
  }
  return null;
}

function buildArgs(options: EngineRunOptions): string[] {
  const args: string[] = [];
  if (options.maxFileBytes !== undefined) args.push('--max-file-bytes', String(options.maxFileBytes));
  if (options.maxFiles !== undefined) args.push('--max-files', String(options.maxFiles));
  if (options.maxDepth !== undefined) args.push('--max-depth', String(options.maxDepth));
  if (options.maxTotalBytes !== undefined) args.push('--max-total-bytes', String(options.maxTotalBytes));
  if (options.largeFileMode) args.push('--large-file-mode', options.largeFileMode);
  if (options.includeHidden) args.push('--include-hidden');
  if (options.useGitignore === false) args.push('--no-gitignore');
  if (options.extractImports === false) args.push('--no-imports');
  if (options.computeComplexity === false) args.push('--no-complexity');
  for (const pattern of options.extraIgnore ?? []) args.push('--ignore', pattern);
  if (options.outFile) args.push('--out', options.outFile);
  args.push('--progress');
  args.push('--pretty');
  // The repository path is always a discrete argument; it is never part of a
  // shell string, so paths containing spaces or shell metacharacters are safe.
  args.push(options.repoPath);
  return args;
}

/**
 * Locates the engine executable.
 *
 * Resolution order: explicit override, `RIFTMAP_ENGINE_PATH`, the packaged
 * resources directory, the development build output, then `PATH`.
 */
export function resolveEnginePath(explicit?: string): string {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  if (process.env.RIFTMAP_ENGINE_PATH) candidates.push(process.env.RIFTMAP_ENGINE_PATH);

  const exe = process.platform === 'win32' ? 'riftmap-engine.exe' : 'riftmap-engine';
  for (const root of searchRoots()) {
    candidates.push(join(root, 'engine', exe));
    candidates.push(join(root, 'engine', 'zig-out', 'bin', exe));
    candidates.push(join(root, 'resources', 'engine', exe));
  }
  candidates.push(exe);

  for (const candidate of candidates) {
    const full = isAbsolute(candidate) ? candidate : resolve(candidate);
    try {
      if (existsSync(full) && statSync(full).isFile()) return full;
    } catch {
      // Unreadable candidate; keep looking.
    }
  }

  // Fall back to `riftmap-engine` on PATH even if the stat check failed, so the
  // spawned process can report a clearer error.
  return explicit ?? exe;
}

function searchRoots(): string[] {
  const roots: string[] = [];
  // Packaged Electron app. `resourcesPath` only exists inside Electron, so it
  // is accessed through a narrowing cast rather than a global type.
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) roots.push(resourcesPath);
  // Development: walk up from this module to find the repository root, which
  // is the directory containing `engine/build.zig`.
  let current = dirname(new URL(import.meta.url).pathname);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, 'engine', 'build.zig'))) {
      roots.push(current);
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  roots.push(process.cwd());
  return roots;
}
