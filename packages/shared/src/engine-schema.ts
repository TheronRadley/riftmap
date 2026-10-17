import {
  ENGINE_SCHEMA_VERSION,
  type EngineDirectory,
  type EngineDocument,
  type EngineEdge,
  type EngineFile,
  type EngineInfo,
  type EngineLanguage,
  type EngineLimitations,
  type EngineScanInfo,
  type EngineSummary,
  type EngineWarning,
  type ImportConfidence,
} from './engine.js';
import {
  arr,
  bool,
  int,
  num,
  obj,
  oneOf,
  optField,
  parseJson,
  str,
  ValidationError,
  nullable,
} from './validate.js';

const IMPORT_CONFIDENCES = ['resolved', 'external', 'unresolved'] as const;
const LARGE_FILE_MODES = ['skip', 'count_lines', 'full'] as const;

function readEngineInfo(value: unknown, path: string): EngineInfo {
  const o = obj(value, path);
  return {
    name: str(o.name ?? '', `${path}.name`),
    version: str(o.version ?? '', `${path}.version`),
    zig_version: str(o.zig_version ?? '', `${path}.zig_version`),
    build_mode: str(o.build_mode ?? '', `${path}.build_mode`),
  };
}

function readLimitations(value: unknown, path: string): EngineLimitations {
  const o = obj(value, path);
  const languages = Array.isArray(o.import_languages) ? arr(o.import_languages, `${path}.import_languages`) : [];
  return {
    metrics_are_estimates: o.metrics_are_estimates !== false,
    nested_ignore_files_supported: o.nested_ignore_files_supported === true,
    import_languages: languages.map((v, i) => str(v, `${path}.import_languages[${i}]`)),
    unknown_language_complexity: typeof o.unknown_language_complexity === 'string'
      ? o.unknown_language_complexity
      : 'not analysed',
  };
}

function readScanInfo(value: unknown, path: string): EngineScanInfo {
  const o = obj(value, path);
  const options = obj(o.options ?? {}, `${path}.options`);
  return {
    root: str(o.root ?? '', `${path}.root`),
    started_at_ms: num(o.started_at_ms ?? 0, `${path}.started_at_ms`),
    duration_ms: num(o.duration_ms ?? 0, `${path}.duration_ms`),
    options: {
      max_file_bytes: num(options.max_file_bytes ?? 0, `${path}.options.max_file_bytes`),
      large_file_mode: oneOf(options.large_file_mode ?? 'count_lines', `${path}.options.large_file_mode`, LARGE_FILE_MODES),
      max_files: int(options.max_files ?? 0, `${path}.options.max_files`),
      max_depth: int(options.max_depth ?? 0, `${path}.options.max_depth`),
      include_hidden: options.include_hidden === true,
      use_gitignore: options.use_gitignore !== false,
      extract_imports: options.extract_imports !== false,
      compute_complexity: options.compute_complexity !== false,
    },
    limitations: readLimitations(o.limitations ?? {}, `${path}.limitations`),
  };
}

function readSummary(value: unknown, path: string): EngineSummary {
  const o = obj(value, path);
  const n = (key: keyof EngineSummary) => int(o[key] ?? 0, `${path}.${key}`);
  return {
    file_count: n('file_count'),
    directory_count: n('directory_count'),
    total_bytes: n('total_bytes'),
    total_lines: n('total_lines'),
    code_lines: n('code_lines'),
    blank_lines: n('blank_lines'),
    comment_lines: n('comment_lines'),
    language_count: n('language_count'),
    edge_count: n('edge_count'),
    resolved_edge_count: n('resolved_edge_count'),
    external_edge_count: n('external_edge_count'),
    unresolved_edge_count: n('unresolved_edge_count'),
    files_with_complexity: n('files_with_complexity'),
    files_with_imports: n('files_with_imports'),
    files_skipped_large: n('files_skipped_large'),
    files_skipped_ignored: n('files_skipped_ignored'),
    files_skipped_unreadable: n('files_skipped_unreadable'),
    files_skipped_unsupported: n('files_skipped_unsupported'),
    files_skipped_invalid_name: n('files_skipped_invalid_name'),
    directories_skipped: n('directories_skipped'),
    symlinks_skipped: n('symlinks_skipped'),
    truncated: o.truncated === true,
    elapsed_ms: n('elapsed_ms'),
  };
}

function readFile(value: unknown, path: string): EngineFile {
  const o = obj(value, path);
  return {
    path: str(o.path, `${path}.path`),
    ext: str(o.ext ?? '', `${path}.ext`),
    language: str(o.language ?? 'unknown', `${path}.language`),
    language_name: str(o.language_name ?? 'Unknown', `${path}.language_name`),
    bytes: int(o.bytes ?? 0, `${path}.bytes`),
    lines: int(o.lines ?? 0, `${path}.lines`),
    code_lines: nullable(o.code_lines, `${path}.code_lines`, int),
    blank_lines: nullable(o.blank_lines, `${path}.blank_lines`, int),
    comment_lines: nullable(o.comment_lines, `${path}.comment_lines`, int),
    cyclomatic: nullable(o.cyclomatic, `${path}.cyclomatic`, int),
    branch_count: nullable(o.branch_count, `${path}.branch_count`, int),
    loop_count: nullable(o.loop_count, `${path}.loop_count`, int),
    logical_count: nullable(o.logical_count, `${path}.logical_count`, int),
    max_nesting: nullable(o.max_nesting, `${path}.max_nesting`, int),
    function_count: nullable(o.function_count, `${path}.function_count`, int),
    token_count: nullable(o.token_count, `${path}.token_count`, int),
    content_scanned: o.content_scanned === true,
    complexity_available: o.complexity_available === true,
    imports_available: o.imports_available === true,
    import_count: int(o.import_count ?? 0, `${path}.import_count`),
    resolved_import_count: int(o.resolved_import_count ?? 0, `${path}.resolved_import_count`),
  };
}

function readEdge(value: unknown, path: string): EngineEdge {
  const o = obj(value, path);
  return {
    from: str(o.from, `${path}.from`),
    to: nullable(o.to, `${path}.to`, str),
    raw: str(o.raw ?? '', `${path}.raw`),
    kind: str(o.kind ?? 'unknown', `${path}.kind`),
    confidence: oneOf<ImportConfidence>(o.confidence ?? 'unresolved', `${path}.confidence`, IMPORT_CONFIDENCES),
    line: int(o.line ?? 0, `${path}.line`),
  };
}

function readLanguage(value: unknown, path: string): EngineLanguage {
  const o = obj(value, path);
  return {
    id: str(o.id, `${path}.id`),
    name: str(o.name ?? o.id ?? '', `${path}.name`),
    file_count: int(o.file_count ?? 0, `${path}.file_count`),
    bytes: int(o.bytes ?? 0, `${path}.bytes`),
    code_lines: int(o.code_lines ?? 0, `${path}.code_lines`),
    total_lines: int(o.total_lines ?? 0, `${path}.total_lines`),
    complexity_supported: o.complexity_supported === true,
    imports_supported: o.imports_supported === true,
  };
}

function readDirectory(value: unknown, path: string): EngineDirectory {
  const o = obj(value, path);
  return {
    path: str(o.path ?? '', `${path}.path`),
    file_count: int(o.file_count ?? 0, `${path}.file_count`),
    bytes: int(o.bytes ?? 0, `${path}.bytes`),
    code_lines: int(o.code_lines ?? 0, `${path}.code_lines`),
    total_lines: int(o.total_lines ?? 0, `${path}.total_lines`),
    direct: o.direct !== false,
  };
}

function readWarning(value: unknown, path: string): EngineWarning {
  const o = obj(value, path);
  return {
    code: str(o.code ?? 'unknown', `${path}.code`),
    message: str(o.message ?? '', `${path}.message`),
    path: nullable(o.path, `${path}.path`, str),
  };
}

/** Validates an unknown value into a fully typed engine document. */
export function readEngineDocument(value: unknown, path = '$'): EngineDocument {
  const o = obj(value, path);
  const version = int(o.schemaVersion, `${path}.schemaVersion`);
  if (version !== ENGINE_SCHEMA_VERSION) {
    throw new ValidationError(
      `${path}.schemaVersion`,
      `unsupported engine schema version ${version} (this build understands ${ENGINE_SCHEMA_VERSION}); rebuild the engine or update the app`,
    );
  }
  return {
    schemaVersion: version,
    engine: readEngineInfo(o.engine ?? {}, `${path}.engine`),
    scan: readScanInfo(o.scan ?? {}, `${path}.scan`),
    summary: readSummary(o.summary ?? {}, `${path}.summary`),
    languages: (Array.isArray(o.languages) ? o.languages : []).map((v, i) => readLanguage(v, `${path}.languages[${i}]`)),
    directories: (Array.isArray(o.directories) ? o.directories : []).map((v, i) => readDirectory(v, `${path}.directories[${i}]`)),
    files: (Array.isArray(o.files) ? o.files : []).map((v, i) => readFile(v, `${path}.files[${i}]`)),
    edges: (Array.isArray(o.edges) ? o.edges : []).map((v, i) => readEdge(v, `${path}.edges[${i}]`)),
    warnings: (Array.isArray(o.warnings) ? o.warnings : []).map((v, i) => readWarning(v, `${path}.warnings[${i}]`)),
  };
}

/** Parses and validates the raw JSON emitted by the engine. */
export function parseEngineDocument(text: string): EngineDocument {
  return parseJson(text, readEngineDocument);
}

export { optField, ValidationError, bool };
