/**
 * The single typed contract for the Electron main <-> renderer boundary.
 *
 * The renderer gets exactly this surface and nothing else: no `fs`, no
 * `child_process`, no `require`. Every method validates its arguments in the
 * main process before touching the disk or spawning a process.
 */

import type { AnalysisProgress, HistoryWindow, RepositoryAnalysis } from '@riftmap/shared';

export const IPC = {
  pickFolder: 'riftmap:pick-folder',
  appInfo: 'riftmap:app-info',
  analyze: 'riftmap:analyze',
  cancel: 'riftmap:cancel-analysis',
  progress: 'riftmap:analysis-progress',
  readPreview: 'riftmap:read-preview',
} as const;

export interface AnalyzeRequest {
  /** Client-generated id so progress events and cancellation can be routed. */
  runId: string;
  repoPath: string;
  historyWindowDays: HistoryWindow;
  maxFileBytes?: number;
  maxFiles?: number;
  maxDepth?: number;
  largeFileMode?: 'skip' | 'count_lines' | 'full';
  includeHidden?: boolean;
  useGitignore?: boolean;
  extraIgnore?: string[];
  timeoutMs?: number;
  maxCommits?: number;
}

export type AnalyzeFailureCode =
  | 'invalid-request'
  | 'path-not-found'
  | 'path-not-directory'
  | 'engine-not-found'
  | 'engine-not-executable'
  | 'engine-spawn-failed'
  | 'engine-cancelled'
  | 'engine-timeout'
  | 'engine-exit'
  | 'engine-invalid-json'
  | 'engine-schema'
  | 'cancelled'
  | 'unknown';

export interface AnalyzeFailure {
  ok: false;
  code: AnalyzeFailureCode;
  message: string;
  /** Human readable next step, when there is one. */
  hint?: string;
  /** Raw stderr tail from the native engine, when relevant. */
  stderr?: string;
}

export interface AnalyzeSuccess {
  ok: true;
  analysis: RepositoryAnalysis;
}

export type AnalyzeResult = AnalyzeSuccess | AnalyzeFailure;

export interface AnalysisProgressEvent extends AnalysisProgress {
  runId: string;
}

export interface FilePreviewRequest {
  repoPath: string;
  /** Repository-relative path as reported by the engine. */
  relativePath: string;
  maxBytes?: number;
}

export type FilePreviewResult =
  | {
      ok: true;
      path: string;
      content: string;
      bytes: number;
      truncated: boolean;
      /** Set when the file could not be shown as text. */
      note: string | null;
    }
  | { ok: false; code: PreviewFailureCode; message: string };

export type PreviewFailureCode =
  | 'invalid-path'
  | 'outside-repository'
  | 'not-found'
  | 'not-a-file'
  | 'too-large'
  | 'binary'
  | 'read-failed'
  | 'unknown';

export interface AppInfo {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  /** Engine resolved at startup, or null when it could not be found. */
  engine: { path: string | null; version: string | null; ok: boolean; message: string } | null;
  gitVersion: string | null;
  /** True when running as the browser-only dev preview (no Electron shell). */
  webPreview: boolean;
}

export interface PickFolderResult {
  canceled: boolean;
  path: string | null;
}

export interface RiftmapApi {
  getAppInfo(): Promise<AppInfo>;
  pickFolder(): Promise<PickFolderResult>;
  analyze(request: AnalyzeRequest): Promise<AnalyzeResult>;
  cancelAnalysis(runId: string): Promise<boolean>;
  onAnalysisProgress(listener: (event: AnalysisProgressEvent) => void): () => void;
  readFilePreview(request: FilePreviewRequest): Promise<FilePreviewResult>;
}

declare global {
  interface Window {
    riftmap?: RiftmapApi;
  }
}
