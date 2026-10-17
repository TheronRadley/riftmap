/**
 * The Riftmap domain model: the camelCase, UI-facing representation of an
 * analysis. Everything here is derived from validated engine data and validated
 * Git data - the renderer never sees raw process output.
 */

export type AttentionBand = 'high' | 'moderate' | 'lower';

export const ATTENTION_BAND_LABEL: Record<AttentionBand, string> = {
  high: 'High attention',
  moderate: 'Moderate attention',
  lower: 'Lower attention',
};

export interface ScoreComponentKey {
  key: 'changeFrequency' | 'complexity' | 'size' | 'contributorConcentration';
}

export interface ScoreComponent {
  key: ScoreComponentKey['key'];
  label: string;
  /** Configured weight (0..1). */
  weight: number;
  /** Weight actually applied after redistribution for missing data (0..1). */
  appliedWeight: number;
  /** Normalised component value in 0..1, or null when unavailable. */
  normalized: number | null;
  /** `normalized * appliedWeight * 100`. */
  contribution: number;
  /** Raw measured value, for the breakdown tooltip. */
  raw: number | null;
  rawLabel: string;
  available: boolean;
  /** Why the component was unavailable (only set when `available === false`). */
  unavailableReason?: string;
}

export interface AttentionScore {
  /** 0..100. */
  score: number;
  band: AttentionBand;
  components: ScoreComponent[];
  /** False when no component could be measured for this file. */
  measurable: boolean;
}

export interface FileMetrics {
  path: string;
  name: string;
  dir: string;
  ext: string;
  language: string;
  languageName: string;
  bytes: number;
  lines: number;
  codeLines: number | null;
  blankLines: number | null;
  commentLines: number | null;

  cyclomatic: number | null;
  branchCount: number | null;
  loopCount: number | null;
  logicalCount: number | null;
  maxNesting: number | null;
  functionCount: number | null;
  tokenCount: number | null;
  complexityAvailable: boolean;
  importsAvailable: boolean;
  contentScanned: boolean;

  importCount: number;
  resolvedImportCount: number;
}

export interface FileGitStats {
  /** Commits touching this file inside the selected window. */
  changeCount: number;
  /** Distinct authors inside the window. */
  authors: number;
  /** Author -> commit count inside the window (top contributors first). */
  authorCounts: Array<{ author: string; commits: number }>;
  lastModified: number | null;
  firstSeen: number | null;
  insertions: number;
  deletions: number;
  churn: number;
  /** Concentration of authorship in 0..1 (null when there is too little history). */
  contributorConcentration: number | null;
}

export interface AnalyzedFile extends FileMetrics {
  git: FileGitStats | null;
  score: AttentionScore;
  /** Number of resolved incoming edges (files that depend on this one). */
  dependentCount: number;
  /** Number of resolved outgoing edges (files this one depends on). */
  dependencyCount: number;
}

export interface LanguageStat {
  id: string;
  name: string;
  fileCount: number;
  bytes: number;
  codeLines: number;
  totalLines: number;
  complexitySupported: boolean;
  importsSupported: boolean;
}

export interface DirectoryStat {
  path: string;
  name: string;
  /** Direct children only. */
  fileCount: number;
  bytes: number;
  codeLines: number;
  totalLines: number;
}

export interface DirectoryNode extends DirectoryStat {
  /** Aggregated over the whole subtree. */
  totalFileCount: number;
  totalBytes: number;
  children: DirectoryNode[];
  /** Files directly inside this directory. */
  files: string[];
}

export interface DependencyEdge {
  from: string;
  to: string | null;
  raw: string;
  kind: string;
  confidence: 'resolved' | 'external' | 'unresolved';
  line: number;
}

export interface GitCommit {
  hash: string;
  authorName: string;
  authorEmail: string;
  authorDate: number;
  commitDate: number;
  subject: string;
  files: Array<{ path: string; added: number; deleted: number }>;
}

export interface GitStatus {
  available: boolean;
  error: string | null;
  isGitRepo: boolean;
  root: string | null;
  isShallow: boolean;
  /** null when the repository has no commits. */
  commitCount: number | null;
  headCommit: string | null;
  hasUncommittedChanges: boolean;
  uncommittedFileCount: number;
  /** True when the commit history was truncated by a safety limit. */
  truncated: boolean;
}

export interface GitSummary {
  commitsInWindow: number;
  filesChangedInWindow: number;
  contributorsInWindow: number;
  insertionsInWindow: number;
  deletionsInWindow: number;
  oldestCommit: number | null;
  newestCommit: number | null;
  /** Commits in the full retrieved history (not just the window). */
  commitsRetrieved: number;
  shallow: boolean;
}

export interface CoverageInfo {
  filesTotal: number;
  filesWithComplexity: number;
  filesWithGitHistory: number;
  filesWithImports: number;
  /** 0..100 */
  complexityCoveragePct: number;
  gitCoveragePct: number;
  languagesWithoutComplexity: string[];
  languagesWithoutImports: string[];
  truncated: boolean;
  notes: string[];
}

export interface RepositoryAnalysis {
  schemaVersion: 1;
  repository: {
    path: string;
    name: string;
    analyzedAt: number;
    durationMs: number;
  };
  engine: {
    version: string;
    zigVersion: string;
    buildMode: string;
    elapsedMs: number;
    options: {
      maxFileBytes: number;
      largeFileMode: string;
      maxFiles: number;
      maxDepth: number;
      includeHidden: boolean;
      useGitignore: boolean;
      extractImports: boolean;
      computeComplexity: boolean;
    };
    limitations: {
      metricsAreEstimates: boolean;
      nestedIgnoreFilesSupported: boolean;
      importLanguages: string[];
      unknownLanguageComplexity: string;
    };
  };
  git: GitStatus & { summary: GitSummary };
  historyWindowDays: number | 'all';
  summary: {
    fileCount: number;
    directoryCount: number;
    totalBytes: number;
    totalLines: number;
    codeLines: number;
    blankLines: number;
    commentLines: number;
    languageCount: number;
    edgeCount: number;
    resolvedEdgeCount: number;
    externalEdgeCount: number;
    unresolvedEdgeCount: number;
    filesSkippedLarge: number;
    filesSkippedIgnored: number;
    filesSkippedUnreadable: number;
    filesSkippedUnsupported: number;
    symlinksSkipped: number;
    truncated: boolean;
  };
  coverage: CoverageInfo;
  files: AnalyzedFile[];
  languages: LanguageStat[];
  directories: DirectoryStat[];
  directoryTree: DirectoryNode;
  edges: DependencyEdge[];
  commits: GitCommit[];
  warnings: Array<{ code: string; message: string; path: string | null }>;
  scoreWeights: ScoreWeights;
}

export interface ScoreWeights {
  changeFrequency: number;
  complexity: number;
  size: number;
  contributorConcentration: number;
}

export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = {
  changeFrequency: 0.4,
  complexity: 0.35,
  size: 0.15,
  contributorConcentration: 0.1,
};

export const SCORE_COMPONENT_LABELS: Record<ScoreComponentKey['key'], string> = {
  changeFrequency: 'Change frequency',
  complexity: 'Estimated complexity',
  size: 'File size',
  contributorConcentration: 'Contributor concentration',
};
