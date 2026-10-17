/**
 * Windowed Git statistics and re-scoring.
 *
 * These are pure functions over an already-retrieved commit list, which is why
 * they live in the shared package: the renderer can switch history windows
 * (30 / 90 / 180 / all) instantly and without any Node-only dependency, and the
 * analysis package uses the exact same code when it first builds an analysis.
 */

import { authorshipConcentration } from './score.js';
import { buildDirectoryTree } from './treemap.js';
import { computeAttentionScores } from './score.js';
import type {
  AnalyzedFile,
  CoverageInfo,
  DependencyEdge,
  DirectoryStat,
  FileGitStats,
  GitCommit,
  GitSummary,
  LanguageStat,
  RepositoryAnalysis,
  ScoreWeights,
} from './model.js';

export const HISTORY_WINDOWS = [30, 90, 180, 'all'] as const;
export type HistoryWindow = (typeof HISTORY_WINDOWS)[number];

export interface WindowedStats {
  commits: GitCommit[];
  fileStats: Map<string, FileGitStats>;
  summary: GitSummary;
}

/**
 * Derives per-file statistics for a time window from the retrieved commits.
 *
 * `windowDays: 'all'` uses the whole retrieved history. Otherwise the window is
 * `[now - windowDays * 86400000, now]`, measured against the *committer*
 * timestamp, which is what Git's own `--since` uses.
 */
export function computeWindowedStats(
  commits: readonly GitCommit[],
  options: { windowDays: number | 'all'; now?: number; shallow?: boolean } = { windowDays: 'all' },
): WindowedStats {
  const now = options.now ?? Date.now();
  const cutoff = options.windowDays === 'all' ? Number.NEGATIVE_INFINITY : now - options.windowDays * 86_400_000;

  const inWindow: GitCommit[] = [];
  const fileStats = new Map<string, FileGitStats>();
  const contributors = new Set<string>();
  let insertions = 0;
  let deletions = 0;
  let oldest: number | null = null;
  let newest: number | null = null;

  for (const commit of commits) {
    if (commit.commitDate >= cutoff) {
      inWindow.push(commit);
      contributors.add(normaliseAuthor(commit));
      insertions += commit.files.reduce((acc, file) => acc + file.added, 0);
      deletions += commit.files.reduce((acc, file) => acc + file.deleted, 0);
      if (oldest === null || commit.commitDate < oldest) oldest = commit.commitDate;
      if (newest === null || commit.commitDate > newest) newest = commit.commitDate;
    }
  }

  for (const commit of inWindow) {
    const author = normaliseAuthor(commit);
    for (const file of commit.files) {
      let stats = fileStats.get(file.path);
      if (!stats) {
        stats = {
          changeCount: 0,
          authors: 0,
          authorCounts: [],
          lastModified: null,
          firstSeen: null,
          insertions: 0,
          deletions: 0,
          churn: 0,
          contributorConcentration: null,
        };
        fileStats.set(file.path, stats);
      }
      stats.changeCount += 1;
      stats.insertions += file.added;
      stats.deletions += file.deleted;
      stats.churn += file.added + file.deleted;
      if (stats.lastModified === null || commit.commitDate > stats.lastModified) {
        stats.lastModified = commit.commitDate;
      }
      if (stats.firstSeen === null || commit.commitDate < stats.firstSeen) {
        stats.firstSeen = commit.commitDate;
      }
      bumpAuthor(stats.authorCounts, author);
    }
  }

  for (const stats of fileStats.values()) {
    stats.authorCounts.sort((a, b) => b.commits - a.commits || a.author.localeCompare(b.author));
    stats.authors = stats.authorCounts.length;
    const counts = new Map(stats.authorCounts.map((entry) => [entry.author, entry.commits]));
    stats.contributorConcentration = authorshipConcentration(counts);
  }

  const summary: GitSummary = {
    commitsInWindow: inWindow.length,
    filesChangedInWindow: fileStats.size,
    contributorsInWindow: contributors.size,
    insertionsInWindow: insertions,
    deletionsInWindow: deletions,
    oldestCommit: oldest,
    newestCommit: newest,
    commitsRetrieved: commits.length,
    shallow: options.shallow === true,
  };

  return { commits: inWindow, fileStats, summary };
}

function bumpAuthor(list: Array<{ author: string; commits: number }>, author: string): void {
  const existing = list.find((entry) => entry.author === author);
  if (existing) existing.commits += 1;
  else list.push({ author, commits: 1 });
}

/** Author identity used for counting: name plus lower-cased e-mail domain key. */
function normaliseAuthor(commit: GitCommit): string {
  const name = commit.authorName.trim();
  const email = commit.authorEmail.trim().toLowerCase();
  if (!email) return name || 'unknown';
  return `${name} <${email}>`;
}

/**
 * Re-scores an existing analysis for a different history window.
 *
 * The source scan does not depend on the window, so switching 30/90/180/all is
 * a pure computation over the already-retrieved commits - no process is spawned
 * and the Zig engine is not re-run.
 */
export function recomputeForWindow(
  analysis: RepositoryAnalysis,
  windowDays: HistoryWindow,
  weights?: Partial<ScoreWeights>,
): RepositoryAnalysis {
  const windowed = computeWindowedStats(analysis.commits, {
    windowDays,
    shallow: analysis.git.isShallow,
    now: analysis.repository.analyzedAt,
  });

  const dependencyCounts = new Map<string, number>();
  const dependentCounts = new Map<string, number>();
  for (const edge of analysis.edges) {
    if (edge.confidence !== 'resolved' || !edge.to) continue;
    dependencyCounts.set(edge.from, (dependencyCounts.get(edge.from) ?? 0) + 1);
    dependentCounts.set(edge.to, (dependentCounts.get(edge.to) ?? 0) + 1);
  }

  const scoreInput = analysis.files.map((file) => {
    const git = windowed.fileStats.get(file.path) ?? null;
    return {
      path: file.path,
      language: file.language,
      bytes: file.bytes,
      cyclomatic: file.cyclomatic,
      changeCount: git?.changeCount ?? 0,
      authors: git?.authors ?? 0,
      contributorConcentration: git?.contributorConcentration ?? null,
      hasGitHistory: analysis.git.isGitRepo && analysis.git.headCommit !== null && analysis.commits.length > 0,
    };
  });
  const scores = computeAttentionScores(scoreInput, { weights: weights ?? analysis.scoreWeights });

  const files = analysis.files.map((file, index) => ({
    ...file,
    git: windowed.fileStats.get(file.path) ?? null,
    score: scores.scores[index]!,
    dependencyCount: dependencyCounts.get(file.path) ?? 0,
    dependentCount: dependentCounts.get(file.path) ?? 0,
  }));

  const languages = analysis.languages;
  const coverage = buildCoverageFromFiles(analysis, files, languages);
  const directoryTree = buildDirectoryTree(files, analysis.directories);

  return {
    ...analysis,
    historyWindowDays: windowDays,
    scoreWeights: scores.weights,
    files,
    directoryTree,
    coverage,
    commits: windowed.commits,
    git: {
      ...analysis.git,
      summary: { ...windowed.summary, commitsRetrieved: analysis.commits.length },
    },
  };
}

/**
 * Computes how much of the repository was actually measurable.
 *
 * Coverage is reported, never filled in: files with no Git history or no
 * complexity support are excluded from the relevant percentage and their score
 * components are dropped rather than replaced with a zero.
 */
export function buildCoverageFromFiles(
  base: Pick<RepositoryAnalysis, 'summary'>,
  files: readonly AnalyzedFile[],
  languages: readonly LanguageStat[],
): CoverageInfo {
  const total = files.length;
  const withComplexity = files.filter((file) => file.cyclomatic !== null).length;
  const withGit = files.filter((file) => file.git !== null).length;
  const withImports = files.filter((file) => file.importCount > 0).length;

  const notes: string[] = [];
  const languagesWithoutComplexity = languages
    .filter((language) => !language.complexitySupported)
    .map((language) => language.name);
  const languagesWithoutImports = languages
    .filter((language) => !language.importsSupported)
    .map((language) => language.name);

  if (languagesWithoutComplexity.length > 0) {
    notes.push(
      `No complexity for ${languagesWithoutComplexity.slice(0, 4).join(', ')}${
        languagesWithoutComplexity.length > 4 ? ` and ${languagesWithoutComplexity.length - 4} more` : ''
      }: the engine uses a lexical estimate and only understands a fixed set of languages.`,
    );
  }
  if (languagesWithoutImports.length > 0) {
    notes.push(
      `No import extraction for ${languagesWithoutImports.slice(0, 4).join(', ')}${
        languagesWithoutImports.length > 4 ? ` and ${languagesWithoutImports.length - 4} more` : ''
      }.`,
    );
  }
  notes.push(
    'Complexity is a lexical estimate (branch and loop keywords), not a parse of the language grammar.',
  );
  if (base.summary.filesSkippedLarge > 0) {
    notes.push(`${base.summary.filesSkippedLarge} file(s) exceeded the size limit: only size and line count were collected.`);
  }
  if (base.summary.filesSkippedUnreadable > 0) {
    notes.push(`${base.summary.filesSkippedUnreadable} file(s) could not be read and are counted from metadata only.`);
  }
  if (base.summary.truncated) {
    notes.push('The scan hit a safety limit and stopped early; the numbers below describe a partial repository.');
  }

  return {
    filesTotal: total,
    filesWithComplexity: withComplexity,
    filesWithGitHistory: withGit,
    filesWithImports: withImports,
    complexityCoveragePct: total === 0 ? 0 : (withComplexity / total) * 100,
    gitCoveragePct: total === 0 ? 0 : (withGit / total) * 100,
    languagesWithoutComplexity,
    languagesWithoutImports,
    truncated: base.summary.truncated,
    notes,
  };
}

/** Progress stages reported while an analysis is running. */
export type AnalysisStage = 'preparing' | 'source' | 'history' | 'scoring' | 'complete';

export interface AnalysisProgress {
  stage: AnalysisStage;
  label: string;
  files?: number;
  directories?: number;
  bytes?: number;
  elapsedMs?: number;
}
