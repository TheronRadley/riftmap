/**
 * Safe process execution for Git.
 *
 * Every Git invocation uses `spawn` with a discrete argument array: repository
 * paths are never interpolated into a shell string, so a repository path
 * containing spaces, quotes, `$(...)`, non-ASCII characters or newlines cannot
 * change the command that runs.
 *
 * All commands are strictly read-only. Riftmap never checks out a branch,
 * resets a file, writes to the index or rewrites history.
 */

import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

export class GitCommandError extends Error {
  readonly code: string;
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor(code: string, message: string, stderr: string, exitCode: number | null) {
    super(message);
    this.name = 'GitCommandError';
    this.code = code;
    this.stderr = stderr.slice(0, 2000);
    this.exitCode = exitCode;
  }
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  /** Working directory for the process (the repository path). */
  cwd?: string;
  /** Milliseconds before the process is killed. */
  timeoutMs?: number;
  /** Hard cap on captured stdout/stderr bytes. */
  maxBuffer?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Runs `git` with the given arguments.
 *
 * The repository path is passed via `-C <path>`, which Git treats as a literal
 * directory argument. The `-c core.quotepath=false` flag keeps file names in
 * their raw encoding, and `--no-pager` prevents Git from blocking on a pager.
 */
export function runGit(args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
  const child = spawnGit(args, options);

  return new Promise<ExecResult>((resolve, reject) => {
    let settled = false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const onAbort = () => {
      killed = true;
      child.kill('SIGKILL');
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < maxBuffer) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < maxBuffer) stderr += chunk.toString('utf8');
    });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(() => {
        if (error.code === 'ENOENT') {
          reject(new GitCommandError('git-missing', 'the git executable could not be found on PATH', '', null));
        } else {
          reject(new GitCommandError('git-spawn-failed', error.message, '', null));
        }
      });
    });

    child.on('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
      finish(() => {
        if (killed) {
          const reason = options.signal?.aborted ? 'cancelled' : `timed out after ${timeoutMs} ms`;
          reject(new GitCommandError('git-cancelled', `git ${args[0] ?? ''} ${reason}`, stderr, exitCode));
          return;
        }
        if (signal) {
          reject(new GitCommandError('git-signalled', `git exited via signal ${signal}`, stderr, exitCode));
          return;
        }
        resolve({ stdout, stderr, exitCode: exitCode ?? 0 });
      });
    });
  });
}

/** `stdio: ['ignore', 'pipe', 'pipe']` gives a null stdin and readable pipes. */
type GitChildProcess = ChildProcessByStdio<null, Readable, Readable>;

function spawnGit(args: readonly string[], options: ExecOptions): GitChildProcess {
  const fullArgs = ['--no-pager', '-c', 'core.quotepath=false', ...args];
  return spawn('git', fullArgs, {
    cwd: options.cwd ?? process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      // Belt and braces: stop git from invoking a pager or an editor, and make
      // sure an interactive prompt can never block a scan.
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
    },
  });
}

/** Returns null when Git is not installed; otherwise its version string. */
export async function detectGitVersion(): Promise<string | null> {
  try {
    const result = await runGit(['--version'], { timeoutMs: 15_000 });
    if (result.exitCode !== 0) return null;
    const match = /git version (\S+)/.exec(result.stdout);
    return match?.[1] ?? result.stdout.trim();
  } catch (error) {
    if (error instanceof GitCommandError && error.code === 'git-missing') return null;
    throw error;
  }
}
