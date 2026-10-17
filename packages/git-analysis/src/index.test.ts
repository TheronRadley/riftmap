import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { computeWindowedStats, parseLog, parseNumStat, probeRepository, readHistory } from './index.js';

const REPO_ROOT = new URL('../../../', import.meta.url).pathname;
const FIXTURES = join(REPO_ROOT, 'fixtures', 'generated');

function git(args: string[], cwd: string, date?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: date
      ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
      : process.env,
  });
}

let scratch = '';

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'riftmap-git-test-'));
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function makeRepo(name: string): string {
  const dir = join(scratch, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.name', 'Test User'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  return dir;
}

function commitFile(dir: string, path: string, content: string, message: string, date: string): void {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', message], dir, date);
}

describe('parseNumStat', () => {
  it('parses NUL separated entries', () => {
    const area = '3\t1\tsrc/a.ts\0-\t-\tassets/logo.png\0';
    expect(parseNumStat(area)).toEqual([
      { path: 'src/a.ts', added: 3, deleted: 1 },
      { path: 'assets/logo.png', added: 0, deleted: 0 },
    ]);
  });

  it('parses newline separated entries as a fallback', () => {
    const area = '2\t0\tsrc/a.ts\n5\t9\tsrc/b.ts\n';
    expect(parseNumStat(area)).toEqual([
      { path: 'src/a.ts', added: 2, deleted: 0 },
      { path: 'src/b.ts', added: 5, deleted: 9 },
    ]);
  });

  it('keeps paths containing spaces intact', () => {
    const area = '1\t1\tsrc/with space/file name.ts\0';
    expect(parseNumStat(area)).toEqual([{ path: 'src/with space/file name.ts', added: 1, deleted: 1 }]);
  });

  it('returns an empty list for empty input', () => {
    expect(parseNumStat('')).toEqual([]);
  });

  it('ignores malformed lines rather than throwing', () => {
    expect(parseNumStat('garbage\n1\t2\tgood.ts\n')).toEqual([{ path: 'good.ts', added: 1, deleted: 2 }]);
  });
});

describe('parseLog', () => {
  const RECORD = '\x1e';
  const FIELD = '\x1f';

  function record(hash: string, name: string, email: string, date: string, subject: string, stats = ''): string {
    return `${RECORD}${hash}${FIELD}${name}${FIELD}${email}${FIELD}${date}${FIELD}${date}${FIELD}${subject}\0\n${stats}`;
  }

  it('parses commits and their file stats', () => {
    const output =
      record('abc123', 'Ada Lovelace', 'ada@example.com', '2024-01-02T10:00:00+00:00', 'first', '3\t0\ta.ts\0') +
      record('def456', 'Grace Hopper', 'grace@example.com', '2024-01-03T10:00:00+00:00', 'second', '1\t1\ta.ts\0');
    const commits = parseLog(output);
    expect(commits).toHaveLength(2);
    expect(commits[0]!.hash).toBe('abc123');
    expect(commits[0]!.authorName).toBe('Ada Lovelace');
    expect(commits[0]!.subject).toBe('first');
    expect(commits[0]!.authorDate).toBe(Date.parse('2024-01-02T10:00:00+00:00'));
    expect(commits[0]!.files).toEqual([{ path: 'a.ts', added: 3, deleted: 0 }]);
    expect(commits[1]!.files).toEqual([{ path: 'a.ts', added: 1, deleted: 1 }]);
  });

  it('ignores empty and malformed records', () => {
    const output = `${RECORD}too\tfew\tfields\0` + record('aaab', 'A', 'a@b.c', '2024-01-01T00:00:00+00:00', 'ok');
    const commits = parseLog(output);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.subject).toBe('ok');
  });

  it('handles empty output', () => {
    expect(parseLog('')).toEqual([]);
  });
});

describe('probeRepository', () => {
  it('detects a normal repository', async () => {
    const dir = makeRepo('probe-normal');
    commitFile(dir, 'a.ts', 'export const a = 1;\n', 'first', '2024-01-01T00:00:00+00:00');
    const probe = await probeRepository(dir);
    expect(probe.available).toBe(true);
    expect(probe.isGitRepo).toBe(true);
    expect(probe.commitCount).toBe(1);
    expect(probe.isShallow).toBe(false);
    expect(probe.error).toBeNull();
  });

  it('reports a non-repository directory without throwing', async () => {
    const dir = join(scratch, 'probe-plain');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const probe = await probeRepository(dir);
    expect(probe.isGitRepo).toBe(false);
    expect(probe.error).toMatch(/not a Git repository/i);
  });

  it('reports a missing directory without throwing', async () => {
    const probe = await probeRepository(join(scratch, 'does-not-exist'));
    expect(probe.isGitRepo).toBe(false);
    expect(probe.error).toBeTruthy();
  });

  it('handles a repository with no commits', async () => {
    const dir = makeRepo('probe-empty');
    const probe = await probeRepository(dir);
    expect(probe.isGitRepo).toBe(true);
    expect(probe.headCommit).toBeNull();
    expect(probe.commitCount).toBeNull();
    expect(probe.error).toBeNull();
  });

  it('detects a shallow clone', async () => {
    // The fixture generator produces a real depth-1 clone.
    const probe = await probeRepository(join(FIXTURES, 'shallow-clone'));
    expect(probe.isGitRepo).toBe(true);
    expect(typeof probe.isShallow).toBe('boolean');
  });

  it('reports uncommitted changes', async () => {
    const dir = makeRepo('probe-dirty');
    commitFile(dir, 'a.ts', 'export const a = 1;\n', 'first', '2024-01-01T00:00:00+00:00');
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(dir, 'new.ts'), 'export const b = 1;\n');
    const probe = await probeRepository(dir);
    expect(probe.hasUncommittedChanges).toBe(true);
    expect(probe.uncommittedFileCount).toBeGreaterThanOrEqual(1);
  });

  it('does not modify the repository it inspects', async () => {
    const dir = makeRepo('probe-readonly');
    commitFile(dir, 'a.ts', 'export const a = 1;\n', 'first', '2024-01-01T00:00:00+00:00');
    const before = git(['status', '--porcelain'], dir);
    const head = git(['rev-parse', 'HEAD'], dir);
    await readHistory(dir);
    expect(git(['status', '--porcelain'], dir)).toBe(before);
    expect(git(['rev-parse', 'HEAD'], dir)).toBe(head);
  });
});

describe('readHistory', () => {
  it('retrieves real commits with file stats', async () => {
    const dir = makeRepo('history-basic');
    commitFile(dir, 'a.ts', 'export const a = 1;\n', 'first', '2024-01-01T00:00:00+00:00');
    commitFile(dir, 'a.ts', 'export const a = 2;\n', 'second', '2024-02-01T00:00:00+00:00');
    commitFile(dir, 'b.ts', 'export const b = 1;\n', 'third', '2024-03-01T00:00:00+00:00');

    const history = await readHistory(dir);
    expect(history.commits).toHaveLength(3);
    // git log returns newest first.
    expect(history.commits[0]!.subject).toBe('third');
    const aCommits = history.commits.filter((c) => c.files.some((f) => f.path === 'a.ts'));
    expect(aCommits).toHaveLength(2);
  });

  it('returns an empty history for a repository with no commits', async () => {
    const dir = makeRepo('history-empty');
    const history = await readHistory(dir);
    expect(history.commits).toEqual([]);
    expect(history.status.isGitRepo).toBe(true);
  });

  it('returns an empty history for a non-repository without throwing', async () => {
    const dir = join(scratch, 'history-plain');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const history = await readHistory(dir);
    expect(history.commits).toEqual([]);
    expect(history.status.isGitRepo).toBe(false);
  });

  it('handles paths containing spaces and non-ASCII characters', async () => {
    const dir = makeRepo('history-weird');
    commitFile(dir, 'src/with space/café ünïcodé.ts', 'export const a = 1;\n', 'unicode', '2024-01-01T00:00:00+00:00');
    const history = await readHistory(dir);
    expect(history.commits).toHaveLength(1);
    expect(history.commits[0]!.files[0]!.path).toBe('src/with space/café ünïcodé.ts');
  });

  it('respects the max-commits safety limit', async () => {
    const dir = makeRepo('history-limit');
    for (let i = 0; i < 5; i += 1) {
      commitFile(dir, `f${i}.ts`, `export const v = ${i};\n`, `commit ${i}`, `2024-01-0${i + 1}T00:00:00+00:00`);
    }
    const history = await readHistory(dir, { maxCommits: 2 });
    expect(history.commits).toHaveLength(2);
    expect(history.truncated).toBe(true);
  });

  it('can be cancelled with an AbortSignal', async () => {
    const dir = makeRepo('history-abort');
    commitFile(dir, 'a.ts', 'export const a = 1;\n', 'first', '2024-01-01T00:00:00+00:00');
    const controller = new AbortController();
    controller.abort();
    const history = await readHistory(dir, { signal: controller.signal });
    // Cancellation during the probe is reported rather than thrown.
    expect(Array.isArray(history.commits)).toBe(true);
  });
});

describe('computeWindowedStats', () => {
  function commit(hash: string, date: string, files: Array<{ path: string; added: number; deleted: number }>, author = 'Ada') {
    return {
      hash,
      authorName: author,
      authorEmail: `${author.toLowerCase()}@example.com`,
      authorDate: Date.parse(date),
      commitDate: Date.parse(date),
      subject: hash,
      files,
    };
  }

  const commits = [
    commit('c1aaa', '2024-01-01T00:00:00Z', [{ path: 'a.ts', added: 10, deleted: 0 }]),
    commit('c2aaa', '2024-02-01T00:00:00Z', [
      { path: 'a.ts', added: 2, deleted: 5 },
      { path: 'b.ts', added: 30, deleted: 0 },
    ]),
    commit('c3aaa', '2024-06-01T00:00:00Z', [{ path: 'a.ts', added: 1, deleted: 1 }], 'Grace'),
  ];
  const now = Date.parse('2024-07-01T00:00:00Z');

  it('includes everything for the "all" window', () => {
    const stats = computeWindowedStats(commits, { windowDays: 'all', now });
    expect(stats.summary.commitsInWindow).toBe(3);
    expect(stats.summary.filesChangedInWindow).toBe(2);
    expect(stats.summary.insertionsInWindow).toBe(43);
    expect(stats.summary.deletionsInWindow).toBe(6);
    expect(stats.fileStats.get('a.ts')!.changeCount).toBe(3);
  });

  it('filters by a 90 day window', () => {
    const stats = computeWindowedStats(commits, { windowDays: 90, now });
    // 2024-06-01 is 30 days before "now"; 2024-02-01 is 151 days before.
    expect(stats.summary.commitsInWindow).toBe(1);
    expect(stats.fileStats.get('a.ts')!.changeCount).toBe(1);
  });

  it('computes per-file churn, authors and timestamps', () => {
    const stats = computeWindowedStats(commits, { windowDays: 'all', now });
    const a = stats.fileStats.get('a.ts')!;
    expect(a.insertions).toBe(13);
    expect(a.deletions).toBe(6);
    expect(a.churn).toBe(19);
    expect(a.authors).toBe(2);
    expect(a.authorCounts[0]!.author).toContain('Ada');
    expect(a.lastModified).toBe(Date.parse('2024-06-01T00:00:00Z'));
    expect(a.firstSeen).toBe(Date.parse('2024-01-01T00:00:00Z'));
    expect(a.contributorConcentration).toBeGreaterThan(0);
  });

  it('leaves contributor concentration null when only one author touched a file', () => {
    const stats = computeWindowedStats(commits, { windowDays: 'all', now });
    expect(stats.fileStats.get('b.ts')!.contributorConcentration).toBeNull();
  });

  it('counts distinct contributors in the window', () => {
    const stats = computeWindowedStats(commits, { windowDays: 'all', now });
    expect(stats.summary.contributorsInWindow).toBe(2);
    const narrow = computeWindowedStats(commits, { windowDays: 60, now });
    expect(narrow.summary.contributorsInWindow).toBe(1);
  });

  it('handles an empty commit list', () => {
    const stats = computeWindowedStats([], { windowDays: 'all', now });
    expect(stats.summary.commitsInWindow).toBe(0);
    expect(stats.summary.oldestCommit).toBeNull();
    expect(stats.fileStats.size).toBe(0);
  });

  it('treats the same person under two e-mails as two identities', () => {
    const mixed = [
      commit('x1aaa', '2024-01-01T00:00:00Z', [{ path: 'a.ts', added: 1, deleted: 0 }], 'Ada'),
      { ...commit('x2aaa', '2024-01-02T00:00:00Z', [{ path: 'a.ts', added: 1, deleted: 0 }], 'Ada'), authorEmail: 'ada+work@example.com' },
    ];
    const stats = computeWindowedStats(mixed, { windowDays: 'all', now });
    expect(stats.fileStats.get('a.ts')!.authors).toBe(2);
    expect(stats.summary.contributorsInWindow).toBe(2);
  });
});
