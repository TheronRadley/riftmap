/**
 * Wire types for the JSON document emitted by the native Zig engine.
 *
 * The engine emits `snake_case` (idiomatic Zig). These types describe the
 * contract exactly as it appears on the wire; `validate.ts` checks it and
 * `model.ts` maps it into the camelCase domain model used by the UI.
 *
 * See docs/JSON_SCHEMA.md for field-by-field documentation.
 */

export const ENGINE_SCHEMA_VERSION = 2;

export type ImportConfidence = 'resolved' | 'external' | 'unresolved';

export interface EngineInfo {
  name: string;
  version: string;
  zig_version: string;
  build_mode: string;
}

export interface EngineOptionsEcho {
  max_file_bytes: number;
  large_file_mode: 'skip' | 'count_lines' | 'full';
  max_files: number;
  max_depth: number;
  include_hidden: boolean;
  use_gitignore: boolean;
  extract_imports: boolean;
  compute_complexity: boolean;
}

export interface EngineLimitations {
  metrics_are_estimates: boolean;
  nested_ignore_files_supported: boolean;
  import_languages: string[];
  unknown_language_complexity: string;
}

export interface EngineScanInfo {
  root: string;
  started_at_ms: number;
  duration_ms: number;
  options: EngineOptionsEcho;
  limitations: EngineLimitations;
}

export interface EngineSummary {
  file_count: number;
  directory_count: number;
  total_bytes: number;
  total_lines: number;
  code_lines: number;
  blank_lines: number;
  comment_lines: number;
  language_count: number;
  edge_count: number;
  resolved_edge_count: number;
  external_edge_count: number;
  unresolved_edge_count: number;
  files_with_complexity: number;
  files_with_imports: number;
  files_skipped_large: number;
  files_skipped_ignored: number;
  files_skipped_unreadable: number;
  files_skipped_unsupported: number;
  files_skipped_invalid_name: number;
  directories_skipped: number;
  symlinks_skipped: number;
  truncated: boolean;
  elapsed_ms: number;
}

export interface EngineFile {
  path: string;
  ext: string;
  language: string;
  language_name: string;
  bytes: number;
  lines: number;
  code_lines: number | null;
  blank_lines: number | null;
  comment_lines: number | null;
  cyclomatic: number | null;
  branch_count: number | null;
  loop_count: number | null;
  logical_count: number | null;
  max_nesting: number | null;
  function_count: number | null;
  token_count: number | null;
  content_scanned: boolean;
  complexity_available: boolean;
  imports_available: boolean;
  import_count: number;
  resolved_import_count: number;
}

export interface EngineEdge {
  from: string;
  to: string | null;
  raw: string;
  kind: string;
  confidence: ImportConfidence;
  line: number;
}

export interface EngineLanguage {
  id: string;
  name: string;
  file_count: number;
  bytes: number;
  code_lines: number;
  total_lines: number;
  complexity_supported: boolean;
  imports_supported: boolean;
}

export interface EngineDirectory {
  path: string;
  file_count: number;
  bytes: number;
  code_lines: number;
  total_lines: number;
  direct: boolean;
}

export interface EngineWarning {
  code: string;
  message: string;
  path: string | null;
}

export interface EngineDocument {
  schemaVersion: number;
  engine: EngineInfo;
  scan: EngineScanInfo;
  summary: EngineSummary;
  languages: EngineLanguage[];
  directories: EngineDirectory[];
  files: EngineFile[];
  edges: EngineEdge[];
  warnings: EngineWarning[];
}

/** A progress event emitted by the engine on stderr (one JSON object per line). */
export interface EngineProgressEvent {
  type: 'progress';
  stage: string;
  files: number;
  directories: number;
  bytes: number;
  elapsedMs: number;
}
