/**
 * End-to-end tests: real Git fixtures + the real Zig engine.
 *
 * These exercise the whole pipeline - native scan, Git history, validation,
 * scoring and aggregation - against the repositories in fixtures/generated.
 * Run `npm run fixtures` first.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeRepository, combine, recomputeForWindow } from './index.js';
import { readHistory } from '@riftmap/git-analysis';
import { runEngine, EngineError, resolveEnginePath } from './engine-runner.js';
import type { EngineDocument } from '@riftmap/shared';

const REPO_ROOT = new URL('../../../', import.meta.url).pathname;
const FIXTURES = join(REPO_ROOT, 'fixtures', 'generated');

const fixture = (name: string) => join(FIXTURES, name);

let fixturesReady = false;

beforeAll(() => {
  fixturesReady = existsSync(fixture('tiny-js'));
  if (!fixturesReady) {
    throw new Error('Fixtures are missing. Run: npm run fixtures');
  }
});

function scan(path: string): Promise<EngineDocument> {
  return runEngine({ repoPath: path, enginePath: join(REPO_ROOT, 'engine', 'zig-out', 'bin', 'riftmap-engine') });
}

describe('engine runner', () => {
  it('resolves the engine executable', () => {
    const path = resolveEnginePath();
    expect(typeof path).toBe('string');
    expect(path.length).toBeGreaterThan(0);
  });

  it('produces a validated document for the tiny fixture', async () => {
    const doc = await scan(fixture('tiny-js'));
    expect(doc.schemaVersion).toBe(2);
    expect(doc.files.length).toBeGreaterThan(5);
    expect(doc.summary.file_count).toBe(doc.files.length);
  });

  it('reports a missing repository path as a typed error', async () => {
    await expect(scan(fixture('definitely-not-here'))).rejects.toBeInstanceOf(EngineError);
    await expect(scan(fixture('definitely-not-here'))).rejects.toMatchObject({ code: 'engine-exit' });
  });

  it('refuses a path that is not a directory', async () => {
    await expect(scan(join(fixture('tiny-js'), 'README.md'))).rejects.toBeInstanceOf(EngineError);
  });

  it('honours an AbortSignal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runEngine({
        repoPath: fixture('many-files'),
        enginePath: join(REPO_ROOT, 'engine', 'zig-out', 'bin', 'riftmap-engine'),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(EngineError);
  });

  it('reports progress events', async () => {
    const stages: string[] = [];
    await runEngine({
      repoPath: fixture('many-files'),
      enginePath: join(REPO_ROOT, 'engine', 'zig-out', 'bin', 'riftmap-engine'),
      onProgress: (event) => stages.push(event.stage),
    });
    expect(stages.length).toBeGreaterThan(0);
    expect(stages).toContain('complete');
  });
});

describe('analyzeRepository - tiny-js', () => {
  it('produces a complete analysis', async () => {
    const analysis = await analyzeRepository({ repoPath: fixture('tiny-js'), historyWindowDays: 'all' });

    expect(analysis.repository.name).toBe('tiny-js');
    expect(analysis.files.length).toBeGreaterThan(5);
    expect(analysis.git.isGitRepo).toBe(true);
    expect(analysis.git.commitCount).toBe(5);
    expect(analysis.languages.length).toBeGreaterThan(0);
    expect(analysis.directoryTree.children.length).toBeGreaterThan(0);
  });

  it('ranks the most-changed file at the top of the hotspots', async () => {
    const analysis = await analyzeRepository({ repoPath: fixture('tiny-js'), historyWindowDays: 'all' });
    const app = analysis.files.find((file) => file.path === 'src/app.ts')!;
    const readme = analysis.files.find((file) => file.path === 'README.md')!;
    expect(app.git?.changeCount).toBe(4);
    expect(readme.git?.changeCount).toBe(1);
    expect(app.score.score).toBeGreaterThan(readme.score.score);
  });

  it('gives every file a score in range with a full breakdown', async () => {
    const analysis = await analyzeRepository({ repoPath: fixture('tiny-js'), historyWindowDays: 'all' });
    for (const file of analysis.files) {
      expect(file.score.score).toBeGreaterThanOrEqual(0);
      expect(file.score.score).toBeLessThanOrEqual(100);
      expect(file.score.components).toHaveLength(4);
      const total = file.score.components.reduce((acc, c) => acc + c.contribution, 0);
      expect(total).toBeCloseTo(file.score.score, 1);
    }
  });

  it('resolves internal dependencies and marks bare packages external', async () => {
    const analysis = await analyzeRepository({ repoPath: fixture('tiny-js'), historyWindowDays: 'all' });
    const resolved = analysis.edges.filter((edge) => edge.confidence === 'resolved');
    expect(resolved.length).toBeGreaterThanOrEqual(6);
    const appEdges = analysis.edges.filter((edge) => edge.from === 'src/app.ts');
    expect(appEdges.map((edge) => edge.to).sort()).toEqual(
      ['src/components/Button.tsx', 'src/util/format.ts', 'src/util/parse.ts'].sort(),
    );
  });

  it('counts dependents correctly', async () => {
    const analysis = await analyzeRepository({ repoPath: fixture('tiny-js'), historyWindowDays: 'all' });
    const format = analysis.files.find((file) => file.path === 'src/util/format.ts')!;
    expect(format.dependentCount).toBe(3); // app.ts, Button.tsx, parse.ts
    const button = analysis.files.find((file) => file.path === 'src/components/Button.tsx')!;
    expect(button.dependentCount).toBe(1);
  });

  it('aggregates directory totals', async () => {
    const analysis = await analyzeRepository({ repoPath: fixture('tiny-js'), historyWindowDays: 'all' });
    expect(analysis.directoryTree.totalFileCount).toBe(analysis.files.length);
    const src = analysis.directoryTree.children.find((node) => node.path === 'src')!;
    expect(src.totalFileCount).toBe(4); // app.ts + components + util/*
    expect(src.fileCount).toBe(1); // direct child: app.ts
  });

  it('reports coverage honestly', async () => {
    const analysis = await analyzeRepository({ repoPath: fixture('tiny-js'), historyWindowDays: 'all' });
    expect(analysis.coverage.filesTotal).toBe(analysis.files.length);
    expect(analysis.coverage.complexityCoveragePct).toBeLessThan(100); // markdown + json
    expect(analysis.coverage.languagesWithoutComplexity).toContain('Markdown');
    expect(analysis.coverage.notes.join(' ')).toMatch(/lexical estimate/i);
  });

  it('never mutates the repository', async () => {
    const analysis = await analyzeRepository({ repoPath: fixture('tiny-js'), historyWindowDays: 'all' });
    expect(analysis.git.hasUncommittedChanges).toBe(false);
  });
});

describe('analyzeRepository - edge cases', () => {
  it('handles an empty repository (git initialised, no commits)', async () => {
    const analysis = await analyzeRepository({ repoPath: fixture('empty-repo'), historyWindowDays: 'all' });
    expect(analysis.git.isGitRepo).toBe(true);
    expect(analysis.git.commitCount).toBeNull();
    expect(analysis.commits).toHaveLength(0);
    // Without history the score falls back to size and complexity only.
    for (const file of analysis.files) {
      expect(file.git).toBeNull();
      const change = file.score.components.find((c) => c.key === 'changeFrequency')!;
      expect(change.available).toBe(false);
    }
  });

  it('handles a directory that is not a repository', async () => {
    const analysis = await analyzeRepository({ repoPath: fixture('non-git'), historyWindowDays: 'all' });
    expect(analysis.git.isGitRepo).toBe(false);
    // The fixture lives inside the Riftmap checkout, which *is* a repository,
    // so git walks up and finds its root. Riftmap refuses to attribute a
    // parent project's history to a sub-folder and says so.
    expect(analysis.git.error).toMatch(/not (a git repository|its root)/i);
    expect(analysis.files.length).toBe(2);
    for (const file of analysis.files) expect(file.git).toBeNull();
  });

  it('handles a shallow clone without inventing history', async () => {
    const analysis = await analyzeRepository({ repoPath: fixture('shallow-clone'), historyWindowDays: 'all' });
    expect(analysis.git.isShallow).toBe(true);
    expect(analysis.commits.length).toBe(1);
    expect(analysis.git.summary.shallow).toBe(true);
  });

  it('handles a repository with only unsupported file types', async () => {
    const analysis = await analyzeRepository({ repoPath: fixture('unsupported'), historyWindowDays: 'all' });
    expect(analysis.files).toHaveLength(0);
    expect(analysis.summary.fileCount).toBe(0);
    expect(analysis.coverage.filesTotal).toBe(0);
  });

  it('survives malformed sources without aborting the scan', async () => {
    const analysis = await analyzeRepository({ repoPath: fixture('malformed'), historyWindowDays: 'all' });
    expect(analysis.files.length).toBeGreaterThan(3);
    const ok = analysis.files.find((file) => file.path === 'src/ok.ts')!;
    expect(ok.cyclomatic).toBe(2);
    const empty = analysis.files.find((file) => file.path === 'src/empty.ts')!;
    expect(empty.lines).toBe(0);
    expect(empty.cyclomatic).toBe(1);
    // Every file must still produce a finite, non-crashing score.
    for (const file of analysis.files) {
      expect(Number.isFinite(file.score.score)).toBe(true);
    }
  });

  it('handles a repository path containing spaces and non-ASCII characters', async () => {
    const analysis = await analyzeRepository({
      repoPath: fixture('weird paths — ünïcodé'),
      historyWindowDays: 'all',
    });
    expect(analysis.files.length).toBe(2);
    const unicode = analysis.files.find((file) => file.path.includes('café.ts'));
    expect(unicode).toBeDefined();
    expect(unicode!.git?.changeCount).toBe(1);
  });

  it('handles a large source file with the default size limit', async () => {
    const analysis = await analyzeRepository({ repoPath: fixture('large-file'), historyWindowDays: 'all' });
    expect(analysis.files).toHaveLength(1);
    const file = analysis.files[0]!;
    // Larger than the 8 MiB default? No: ~1.9 MiB, so it is fully scanned.
    expect(file.contentScanned).toBe(true);
    expect(file.lines).toBeGreaterThan(200_000);
  });

  it('skips content scanning when the size limit is lowered', async () => {
    const analysis = await analyzeRepository({
      repoPath: fixture('large-file'),
      historyWindowDays: 'all',
      maxFileBytes: 1024,
      largeFileMode: 'skip',
    });
    const file = analysis.files[0]!;
    expect(file.contentScanned).toBe(false);
    expect(file.cyclomatic).toBeNull();
    expect(analysis.warnings.some((warning) => warning.code === 'file-too-large')).toBe(true);
  });

  it('counts lines of oversized files in count-lines mode', async () => {
    const analysis = await analyzeRepository({
      repoPath: fixture('large-file'),
      historyWindowDays: 'all',
      maxFileBytes: 1024,
    });
    const file = analysis.files[0]!;
    expect(file.lines).toBeGreaterThan(200_000);
    expect(file.cyclomatic).toBeNull();
  });

  it('handles a repository with many files', async () => {
    const analysis = await analyzeRepository({ repoPath: fixture('many-files'), historyWindowDays: 'all' });
    expect(analysis.files.length).toBeGreaterThan(700);
    expect(analysis.edges.filter((edge) => edge.confidence === 'resolved').length).toBeGreaterThan(700);
  });

  it('analyses a Python package with relative imports', async () => {
    const analysis = await analyzeRepository({ repoPath: fixture('python-mixed'), historyWindowDays: 'all' });
    const paths = analysis.files.map((file) => file.path);
    expect(paths).toContain('pkg/core.py');
    expect(paths).toContain('pkg/sub/helpers.py');
    const coreEdges = analysis.edges.filter((edge) => edge.from === 'pkg/core.py');
    expect(coreEdges.map((edge) => edge.to)).toContain('pkg/sub/helpers.py');
    // `import os` is outside the repository.
    expect(coreEdges.some((edge) => edge.raw === 'os' && edge.confidence === 'external')).toBe(true);
  });
});

describe('history windows', () => {
  it('recomputes scores without re-running the source scan', async () => {
    const analysis = await analyzeRepository({ repoPath: fixture('tiny-js'), historyWindowDays: 'all' });
    const thirty = recomputeForWindow(analysis, 30);
    expect(thirty.historyWindowDays).toBe(30);
    expect(thirty.files).toHaveLength(analysis.files.length);
    // The fixture commits are all in 2024, far outside a 30 day window.
    for (const file of thirty.files) {
      expect(file.git).toBeNull();
    }
    expect(thirty.git.summary.commitsInWindow).toBe(0);
  });

  it('keeps the source metrics identical across windows', async () => {
    const analysis = await analyzeRepository({ repoPath: fixture('tiny-js'), historyWindowDays: 'all' });
    const ninety = recomputeForWindow(analysis, 90);
    expect(ninety.summary.totalBytes).toBe(analysis.summary.totalBytes);
    expect(ninety.edges).toHaveLength(analysis.edges.length);
    expect(ninety.files.map((f) => f.cyclomatic)).toEqual(analysis.files.map((f) => f.cyclomatic));
  });

  it('supports 30 / 90 / 180 / all', async () => {
    for (const window of [30, 90, 180, 'all'] as const) {
      const analysis = await analyzeRepository({ repoPath: fixture('tiny-js'), historyWindowDays: window });
      expect(analysis.historyWindowDays).toBe(window);
      expect(analysis.files.length).toBeGreaterThan(0);
    }
  });
});

describe('combine (pure)', () => {
  it('works with engine output and no Git history at all', async () => {
    const doc = await scan(fixture('non-git'));
    const analysis = combine({
      repoPath: fixture('non-git'),
      engineDocument: doc,
      commits: [],
      gitStatus: {
        available: false,
        error: 'Git is not installed or not on PATH',
        isGitRepo: false,
        root: null,
        isShallow: false,
        commitCount: null,
        headCommit: null,
        hasUncommittedChanges: false,
        uncommittedFileCount: 0,
        truncated: false,
      },
      windowDays: 'all',
      analyzedAt: Date.now(),
      engineMs: 1,
    });
    expect(analysis.files).toHaveLength(doc.files.length);
    expect(analysis.coverage.gitCoveragePct).toBe(0);
    for (const file of analysis.files) {
      expect(file.score.measurable).toBe(true);
    }
  });

  it('accepts an empty engine document', async () => {
    const doc = await scan(fixture('unsupported'));
    const history = await readHistory(fixture('unsupported'));
    const analysis = combine({
      repoPath: fixture('unsupported'),
      engineDocument: doc,
      commits: history.commits,
      gitStatus: history.status,
      windowDays: 'all',
      analyzedAt: Date.now(),
      engineMs: 1,
    });
    expect(analysis.files).toHaveLength(0);
    expect(analysis.coverage.filesTotal).toBe(0);
    expect(analysis.directoryTree.children).toHaveLength(0);
  });
});

describe('cancellation', () => {
  it('aborts an in-flight analysis', async () => {
    const controller = new AbortController();
    const promise = analyzeRepository({
      repoPath: fixture('many-files'),
      historyWindowDays: 'all',
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(EngineError);
  });
});
