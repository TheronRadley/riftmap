/**
 * Repository analysis orchestration.
 *
 * This package is the only place that knows about both sides of Riftmap: it
 * runs the Zig engine for source metrics, runs the Git history service for
 * change metrics, validates both, and combines them into the domain model.
 */

import { basename, dirname, extname, resolve } from 'node:path';
import {
  buildCoverageFromFiles,
  buildDirectoryTree,
  computeAttentionScores,
  computeWindowedStats,
  DEFAULT_SCORE_WEIGHTS,
  dirNameOf,
  type AnalysisProgress,
  type AnalysisStage,
  type AnalyzedFile,
  type CoverageInfo,
  type DependencyEdge,
  type DirectoryStat,
  type EngineDocument,
  type EngineFile,
  type EngineProgressEvent,
  type FileGitStats,
  type FileMetrics,
  type GitCommit,
  type GitStatus,
  type GitSummary,
  type HistoryWindow,
  type LanguageStat,
  type RepositoryAnalysis,
  type ScoreWeights,
} from '@riftmap/shared';
import { probeRepository, readHistory } from '@riftmap/git-analysis';
import { EngineError, runEngine, resolveEnginePath, type EngineRunOptions } from './engine-runner.js';

export { EngineError, resolveEnginePath } from './engine-runner.js';
export type { EngineProgressEvent, EngineRunOptions };
export interface AnalyzeRepositoryOptions {
  repoPath: string;
  enginePath?: string;
  historyWindowDays?: HistoryWindow;
  weights?: Partial<ScoreWeights>;
  signal?: AbortSignal;
  onProgress?: (event: AnalysisProgress) => void;
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
  timeoutMs?: number;
  /** Safety limit on retrieved commits. */
  maxCommits?: number;
}

export type { AnalysisProgress, AnalysisStage, HistoryWindow } from '@riftmap/shared';
export { HISTORY_WINDOWS, recomputeForWindow } from '@riftmap/shared';

const STAGE_LABEL: Record<AnalysisStage, string> = {
  preparing: 'Preparing',
  source: 'Scanning source with the Zig engine',
  history: 'Reading Git history',
  scoring: 'Combining metrics',
  complete: 'Complete',
};

export async function analyzeRepository(options: AnalyzeRepositoryOptions): Promise<RepositoryAnalysis> {
  const startedAt = Date.now();
  const repoPath = resolve(options.repoPath);
  const windowDays = options.historyWindowDays ?? 180;
  const report = options.onProgress;

  report?.({ stage: 'preparing', label: STAGE_LABEL.preparing });

  const engineStarted = Date.now();
  const engineDocument = await runEngine({
    repoPath,
    enginePath: options.enginePath,
    maxFileBytes: options.maxFileBytes,
    maxFiles: options.maxFiles,
    maxDepth: options.maxDepth,
    maxTotalBytes: options.maxTotalBytes,
    largeFileMode: options.largeFileMode,
    includeHidden: options.includeHidden,
    useGitignore: options.useGitignore,
    extractImports: options.extractImports,
    computeComplexity: options.computeComplexity,
    extraIgnore: options.extraIgnore,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    onProgress: (event) => {
      report?.({
        stage: 'source',
        label: STAGE_LABEL.source,
        files: event.files,
        directories: event.directories,
        bytes: event.bytes,
        elapsedMs: event.elapsedMs,
      });
    },
  });
  const engineMs = Date.now() - engineStarted;

  report?.({ stage: 'history', label: STAGE_LABEL.history });
  const history = await readHistory(repoPath, {
    signal: options.signal,
    maxCommits: options.maxCommits,
  });

  report?.({ stage: 'scoring', label: STAGE_LABEL.scoring });
  const analysis = combine({
    repoPath,
    engineDocument,
    commits: history.commits,
    gitStatus: history.status,
    windowDays,
    weights: options.weights,
    analyzedAt: startedAt,
    engineMs,
  });

  report?.({ stage: 'complete', label: STAGE_LABEL.complete });
  return analysis;
}

export interface CombineInput {
  repoPath: string;
  engineDocument: EngineDocument;
  commits: readonly GitCommit[];
  gitStatus: GitStatus;
  windowDays: HistoryWindow;
  weights?: Partial<ScoreWeights>;
  analyzedAt: number;
  engineMs: number;
}

/**
 * Combines validated engine output and validated Git history into the domain
 * model. Pure and synchronous, which makes it straightforward to test with
 * fixture data.
 */
export function combine(input: CombineInput): RepositoryAnalysis {
  const { engineDocument: doc, commits, gitStatus, windowDays } = input;

  const windowed = computeWindowedStats(commits, {
    windowDays,
    shallow: gitStatus.isShallow,
    now: input.analyzedAt,
  });

  const dependencyCounts = new Map<string, number>();
  const dependentCounts = new Map<string, number>();
  for (const edge of doc.edges) {
    if (edge.confidence !== 'resolved' || !edge.to) continue;
    dependencyCounts.set(edge.from, (dependencyCounts.get(edge.from) ?? 0) + 1);
    dependentCounts.set(edge.to, (dependentCounts.get(edge.to) ?? 0) + 1);
  }

  const scoreInput = doc.files.map((file) => {
    const git = windowed.fileStats.get(file.path) ?? null;
    return {
      path: file.path,
      language: file.language,
      bytes: file.bytes,
      cyclomatic: file.cyclomatic,
      changeCount: git?.changeCount ?? 0,
      authors: git?.authors ?? 0,
      contributorConcentration: git?.contributorConcentration ?? null,
      hasGitHistory: gitStatus.isGitRepo && gitStatus.headCommit !== null && commits.length > 0,
    };
  });

  const scores = computeAttentionScores(scoreInput, { weights: input.weights });

  const files: AnalyzedFile[] = doc.files.map((file, index) => {
    const git = windowed.fileStats.get(file.path) ?? null;
    return {
      ...toFileMetrics(file),
      git,
      score: scores.scores[index]!,
      dependencyCount: dependencyCounts.get(file.path) ?? 0,
      dependentCount: dependentCounts.get(file.path) ?? 0,
    };
  });

  const languages: LanguageStat[] = doc.languages.map((language) => ({
    id: language.id,
    name: language.name,
    fileCount: language.file_count,
    bytes: language.bytes,
    codeLines: language.code_lines,
    totalLines: language.total_lines,
    complexitySupported: language.complexity_supported,
    importsSupported: language.imports_supported,
  }));

  const directories: DirectoryStat[] = doc.directories.map((directory) => ({
    path: directory.path,
    name: directory.path === '' ? '/' : basename(directory.path) || '/',
    fileCount: directory.file_count,
    bytes: directory.bytes,
    codeLines: directory.code_lines,
    totalLines: directory.total_lines,
  }));

  const directoryTree = buildDirectoryTree(files, directories);

  const edges: DependencyEdge[] = doc.edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    raw: edge.raw,
    kind: edge.kind,
    confidence: edge.confidence,
    line: edge.line,
  }));

  const coverage = buildCoverage(doc, files, languages);

  const summary: GitSummary = {
    ...windowed.summary,
    commitsRetrieved: commits.length,
  };

  return {
    schemaVersion: 1,
    repository: {
      path: input.repoPath,
      name: basename(input.repoPath) || input.repoPath,
      analyzedAt: input.analyzedAt,
      durationMs: Date.now() - input.analyzedAt,
    },
    engine: {
      version: doc.engine.version,
      zigVersion: doc.engine.zig_version,
      buildMode: doc.engine.build_mode,
      elapsedMs: doc.summary.elapsed_ms || input.engineMs,
      options: {
        maxFileBytes: doc.scan.options.max_file_bytes,
        largeFileMode: doc.scan.options.large_file_mode,
        maxFiles: doc.scan.options.max_files,
        maxDepth: doc.scan.options.max_depth,
        includeHidden: doc.scan.options.include_hidden,
        useGitignore: doc.scan.options.use_gitignore,
        extractImports: doc.scan.options.extract_imports,
        computeComplexity: doc.scan.options.compute_complexity,
      },
      limitations: {
        metricsAreEstimates: doc.scan.limitations.metrics_are_estimates,
        nestedIgnoreFilesSupported: doc.scan.limitations.nested_ignore_files_supported,
        importLanguages: doc.scan.limitations.import_languages,
        unknownLanguageComplexity: doc.scan.limitations.unknown_language_complexity,
      },
    },
    git: { ...gitStatus, summary },
    historyWindowDays: windowDays,
    summary: {
      fileCount: doc.summary.file_count,
      directoryCount: doc.summary.directory_count,
      totalBytes: doc.summary.total_bytes,
      totalLines: doc.summary.total_lines,
      codeLines: doc.summary.code_lines,
      blankLines: doc.summary.blank_lines,
      commentLines: doc.summary.comment_lines,
      languageCount: doc.summary.language_count,
      edgeCount: doc.summary.edge_count,
      resolvedEdgeCount: doc.summary.resolved_edge_count,
      externalEdgeCount: doc.summary.external_edge_count,
      unresolvedEdgeCount: doc.summary.unresolved_edge_count,
      filesSkippedLarge: doc.summary.files_skipped_large,
      filesSkippedIgnored: doc.summary.files_skipped_ignored,
      filesSkippedUnreadable: doc.summary.files_skipped_unreadable,
      filesSkippedUnsupported: doc.summary.files_skipped_unsupported,
      symlinksSkipped: doc.summary.symlinks_skipped,
      truncated: doc.summary.truncated,
    },
    coverage,
    files,
    languages,
    directories,
    directoryTree,
    edges,
    commits: windowed.commits,
    warnings: doc.warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
      path: warning.path,
    })),
    scoreWeights: scores.weights,
  };
}

function toFileMetrics(file: EngineFile): FileMetrics {
  const dir = dirNameOf(file.path);
  return {
    path: file.path,
    name: basename(file.path),
    dir,
    ext: extname(file.path).replace(/^\./, '').toLowerCase(),
    language: file.language,
    languageName: file.language_name,
    bytes: file.bytes,
    lines: file.lines,
    codeLines: file.code_lines,
    blankLines: file.blank_lines,
    commentLines: file.comment_lines,
    cyclomatic: file.cyclomatic,
    branchCount: file.branch_count,
    loopCount: file.loop_count,
    logicalCount: file.logical_count,
    maxNesting: file.max_nesting,
    functionCount: file.function_count,
    tokenCount: file.token_count,
    complexityAvailable: file.complexity_available,
    importsAvailable: file.imports_available,
    contentScanned: file.content_scanned,
    importCount: file.import_count,
    resolvedImportCount: file.resolved_import_count,
  };
}

function buildCoverage(doc: EngineDocument, files: readonly AnalyzedFile[], languages: readonly LanguageStat[]): CoverageInfo {
  return buildCoverageFromFiles(
    { summary: { fileCount: doc.summary.file_count, truncated: doc.summary.truncated } } as Pick<RepositoryAnalysis, 'summary'>,
    files,
    languages,
  );
}

