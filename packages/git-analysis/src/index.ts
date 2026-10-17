/**
 * Git history analysis.
 *
 * Riftmap retrieves the commit history once, with a bounded number of commits,
 * and then derives windowed statistics in TypeScript. That keeps window
 * switching (30 / 90 / 180 days / all) instant and free of repeated process
 * spawns, and it keeps every Git invocation read-only.
 */

import type { GitCommit, GitStatus } from '@riftmap/shared';
import { realpath } from 'node:fs/promises';
import { detectGitVersion, GitCommandError, runGit, type ExecOptions } from './exec.js';

export { GitCommandError, detectGitVersion } from './exec.js';
export type { ExecOptions } from './exec.js';

// `computeWindowedStats` is pure (it only needs the already-retrieved commit
// list), so it lives in @riftmap/shared where the renderer can use it without
// pulling in any Node-only Git code. Re-exported here for convenience.
export { computeWindowedStats } from '@riftmap/shared';
export type { WindowedStats } from '@riftmap/shared';

/** Record separator between commits and field separator inside a commit. */
const RECORD_SEP = '\x1e';
const FIELD_SEP = '\x1f';

export interface RepositoryProbe extends GitStatus {
  gitVersion: string | null;
}

export interface HistoryOptions extends ExecOptions {
  /** Safety limit on the number of commits retrieved. */
  maxCommits?: number;
}

export interface HistoryResult {
  status: RepositoryProbe;
  commits: GitCommit[];
  /** True when `maxCommits` truncated the history. */
  truncated: boolean;
}

const DEFAULT_MAX_COMMITS = 20_000;

/**
 * Probes a directory to find out whether Git history is available.
 *
 * Every failure mode is reported rather than thrown: a directory that is not a
 * repository, a repository with no commits, a shallow clone and a missing git
 * executable all produce a usable `RepositoryProbe`.
 */
/** Resolves a path to its canonical form, or null if it cannot be resolved. */
async function resolveCanonical(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

export async function probeRepository(repoPath: string, options: ExecOptions = {}): Promise<RepositoryProbe> {
  const gitVersion = await detectGitVersion();
  const base: RepositoryProbe = {
    available: gitVersion !== null,
    error: gitVersion === null ? 'Git is not installed or not on PATH' : null,
    isGitRepo: false,
    root: null,
    isShallow: false,
    commitCount: null,
    headCommit: null,
    hasUncommittedChanges: false,
    uncommittedFileCount: 0,
    truncated: false,
    gitVersion,
  };

  if (gitVersion === null) return base;

  let topLevel: string;
  try {
    const result = await runGit(['-C', repoPath, 'rev-parse', '--show-toplevel'], options);
    if (result.exitCode !== 0) {
      return { ...base, error: 'This folder is not a Git repository' };
    }
    topLevel = result.stdout.trim();
  } catch (error) {
    return { ...base, error: describeError(error) };
  }
  if (!topLevel) return { ...base, error: 'This folder is not a Git repository' };

  // `--show-toplevel` walks *up* the tree, so a plain directory nested inside
  // some repository reports that repository's root. Riftmap analyses a whole
  // repository, so a path that is not itself the root is reported as
  // "not a repository" with an actionable message rather than silently
  // attributing a parent project's history to it.
  const requestedRoot = await resolveCanonical(repoPath);
  const canonicalTop = await resolveCanonical(topLevel);
  if (requestedRoot && canonicalTop && requestedRoot !== canonicalTop) {
    return {
      ...base,
      root: topLevel,
      error: 'This folder is inside a Git repository but is not its root. Open the repository root instead.',
    };
  }

  const probe: RepositoryProbe = {
    ...base,
    isGitRepo: true,
    root: topLevel,
  };

  // Shallow clone detection (git >= 2.15).
  try {
    const shallow = await runGit(['-C', topLevel, 'rev-parse', '--is-shallow-repository'], options);
    probe.isShallow = shallow.stdout.trim() === 'true';
  } catch {
    // Older git versions do not understand the flag; treat as non-shallow.
  }

  try {
    const head = await runGit(['-C', topLevel, 'rev-parse', 'HEAD'], options);
    probe.headCommit = head.exitCode === 0 ? head.stdout.trim() || null : null;
  } catch {
    probe.headCommit = null;
  }

  if (probe.headCommit) {
    try {
      const count = await runGit(['-C', topLevel, 'rev-list', '--count', 'HEAD'], options);
      const parsed = Number.parseInt(count.stdout.trim(), 10);
      probe.commitCount = Number.isFinite(parsed) ? parsed : null;
    } catch {
      probe.commitCount = null;
    }

    try {
      const status = await runGit(['-C', topLevel, 'status', '--porcelain', '--untracked-files=normal'], options);
      const lines = status.stdout.split('\n').filter((line) => line.trim().length > 0);
      probe.hasUncommittedChanges = lines.length > 0;
      probe.uncommittedFileCount = lines.length;
    } catch {
      // Status is informational only.
    }
  } else {
    // A repository with no commits still exists; report it as such.
    probe.error = null;
  }

  return probe;
}

/**
 * Retrieves the commit history.
 *
 * `--numstat -z` is used so that NUL separators (rather than tabs or newlines)
 * delimit the file entries, which keeps paths containing spaces, quotes and
 * non-ASCII characters intact.
 */
export async function readHistory(repoPath: string, options: HistoryOptions = {}): Promise<HistoryResult> {
  const status = await probeRepository(repoPath, options);
  if (!status.isGitRepo || !status.headCommit) {
    return { status, commits: [], truncated: false };
  }

  const maxCommits = options.maxCommits ?? DEFAULT_MAX_COMMITS;
  const format = `${RECORD_SEP}%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%aI${FIELD_SEP}%cI${FIELD_SEP}%s`;

  let stdout: string;
  try {
    const result = await runGit(
      [
        '-C',
        status.root ?? repoPath,
        'log',
        '--no-renames',
        '--no-show-signature',
        '--date-order',
        `--max-count=${maxCommits}`,
        `--pretty=tformat:${format}`,
        '--numstat',
        '-z',
      ],
      options,
    );
    if (result.exitCode !== 0) {
      return {
        status: { ...status, error: `git log failed: ${result.stderr.trim() || `exit ${result.exitCode}`}` },
        commits: [],
        truncated: false,
      };
    }
    stdout = result.stdout;
  } catch (error) {
    return {
      status: { ...status, error: describeError(error) },
      commits: [],
      truncated: false,
    };
  }

  const commits = parseLog(stdout);
  const truncated = commits.length >= maxCommits;
  return { status: { ...status, truncated }, commits, truncated };
}

/**
 * Parses `git log --pretty=tformat:... --numstat -z` output.
 *
 * With `-z` Git terminates both the pretty-format header and every numstat
 * entry with NUL instead of newline, so paths containing spaces, quotes and
 * non-ASCII characters survive intact. The header is cut at whichever of NUL
 * or newline comes first, which keeps the parser working with or without `-z`.
 */
export function parseLog(output: string): GitCommit[] {
  const commits: GitCommit[] = [];
  const records = output.split(RECORD_SEP);
  for (const record of records) {
    if (record.length === 0) continue;

    const nulIndex = record.indexOf('\0');
    const newlineIndex = record.indexOf('\n');
    let end = -1;
    if (nulIndex === -1) end = newlineIndex;
    else if (newlineIndex === -1) end = nulIndex;
    else end = Math.min(nulIndex, newlineIndex);

    const header = end === -1 ? record : record.slice(0, end);
    const statArea = end === -1 ? '' : record.slice(end + 1);

    const fields = header.split(FIELD_SEP);
    if (fields.length < 6) continue;
    const [hash, authorName, authorEmail, authorIso, commitIso, ...subjectParts] = fields;
    if (!hash || hash.length < 4) continue;

    commits.push({
      hash,
      authorName: authorName ?? '',
      authorEmail: authorEmail ?? '',
      authorDate: Date.parse(authorIso ?? '') || 0,
      commitDate: Date.parse(commitIso ?? '') || 0,
      subject: stripTerminators(subjectParts.join(FIELD_SEP)),
      files: parseNumStat(statArea),
    });
  }
  return commits;
}

/**
 * Parses the numstat area of a single commit.
 *
 * With `--numstat -z` each entry is `<added>\t<deleted>\t<path>\0`. A
 * newline-delimited form is accepted as a fallback so the parser also handles
 * captured output produced without `-z`.
 */
export function parseNumStat(statArea: string): GitCommit['files'] {
  const files: GitCommit['files'] = [];
  if (!statArea) return files;

  const separator = statArea.includes('\0') ? '\0' : '\n';
  for (const raw of statArea.split(separator)) {
    const entry = stripTerminators(raw);
    if (!entry) continue;
    const firstTab = entry.indexOf('\t');
    const secondTab = firstTab === -1 ? -1 : entry.indexOf('\t', firstTab + 1);
    if (firstTab === -1 || secondTab === -1) continue;
    const parsed = parseAddedDeleted(entry.slice(0, secondTab));
    if (!parsed) continue;
    const path = entry.slice(secondTab + 1);
    if (!path) continue;
    files.push({ path, added: parsed.added, deleted: parsed.deleted });
  }
  return files;
}

function parseAddedDeleted(stat: string): { added: number; deleted: number } | null {
  const parts = stat.split('\t');
  if (parts.length < 2) return null;
  // Binary files report `-` for both counts.
  const addedRaw = parts[0] ?? '-';
  const deletedRaw = parts[1] ?? '-';
  const added = addedRaw === '-' ? 0 : Number.parseInt(addedRaw, 10);
  const deleted = deletedRaw === '-' ? 0 : Number.parseInt(deletedRaw, 10);
  return {
    added: Number.isFinite(added) ? added : 0,
    deleted: Number.isFinite(deleted) ? deleted : 0,
  };
}

/** Removes trailing NUL/CR/LF that Git may leave on a field. */
function stripTerminators(value: string): string {
  return value.replace(/[\0\r\n]+$/, '');
}

function describeError(error: unknown): string {
  if (error instanceof GitCommandError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
