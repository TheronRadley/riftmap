import { describe, expect, it } from 'vitest';
import { ENGINE_SCHEMA_VERSION, type EngineDocument } from './engine.js';
import { parseEngineDocument, readEngineDocument } from './engine-schema.js';
import { ValidationError } from './validate.js';

function minimalDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: ENGINE_SCHEMA_VERSION,
    engine: { name: 'riftmap-engine', version: '0.1.0', zig_version: '0.13.0', build_mode: 'ReleaseSafe' },
    scan: {
      root: '/repo',
      started_at_ms: 1,
      duration_ms: 2,
      options: {
        max_file_bytes: 1024,
        large_file_mode: 'count_lines',
        max_files: 10,
        max_depth: 8,
        include_hidden: false,
        use_gitignore: true,
        extract_imports: true,
        compute_complexity: true,
      },
      limitations: {},
    },
    summary: { file_count: 1 },
    languages: [],
    directories: [],
    files: [
      {
        path: 'a.ts',
        ext: 'ts',
        language: 'typescript',
        language_name: 'TypeScript',
        bytes: 10,
        lines: 1,
        code_lines: 1,
        blank_lines: 0,
        comment_lines: 0,
        cyclomatic: 1,
        branch_count: 0,
        loop_count: 0,
        logical_count: 0,
        max_nesting: 0,
        function_count: null,
        token_count: 3,
        content_scanned: true,
        complexity_available: true,
        imports_available: true,
        import_count: 0,
        resolved_import_count: 0,
      },
    ],
    edges: [
      { from: 'a.ts', to: null, raw: 'react', kind: 'static', confidence: 'external', line: 0 },
    ],
    warnings: [],
    ...overrides,
  };
}

describe('readEngineDocument', () => {
  it('accepts a well formed document', () => {
    const doc = readEngineDocument(minimalDocument());
    expect(doc.schemaVersion).toBe(2);
    expect(doc.files).toHaveLength(1);
    expect(doc.files[0]!.function_count).toBeNull();
    expect(doc.edges[0]!.confidence).toBe('external');
  });

  it('rejects an unknown schema version with an actionable message', () => {
    expect(() => readEngineDocument(minimalDocument({ schemaVersion: 99 }))).toThrow(/unsupported engine schema version 99/);
  });

  it('rejects non-object input', () => {
    expect(() => readEngineDocument(null)).toThrow(ValidationError);
    expect(() => readEngineDocument([])).toThrow(ValidationError);
    expect(() => readEngineDocument('nope')).toThrow(ValidationError);
  });

  it('reports the path of the offending field', () => {
    const doc = minimalDocument();
    (doc.files as Record<string, unknown>[])[0]!.bytes = 'not a number';
    expect(() => readEngineDocument(doc)).toThrow(/\$\.files\[0\]\.bytes/);
  });

  it('rejects an unknown edge confidence', () => {
    const doc = minimalDocument();
    (doc.edges as Record<string, unknown>[])[0]!.confidence = 'maybe';
    expect(() => readEngineDocument(doc)).toThrow(/confidence/);
  });

  it('rejects an unknown large-file mode', () => {
    const doc = minimalDocument();
    const scan = doc.scan as Record<string, unknown>;
    (scan.options as Record<string, unknown>).large_file_mode = 'explode';
    expect(() => readEngineDocument(doc)).toThrow(/large_file_mode/);
  });

  it('requires every file to have a path', () => {
    const doc = minimalDocument();
    delete (doc.files as Record<string, unknown>[])[0]!.path;
    expect(() => readEngineDocument(doc)).toThrow(/\$\.files\[0\]\.path/);
  });

  it('tolerates a missing optional section by falling back to defaults', () => {
    const doc = minimalDocument({ limitations: undefined, languages: undefined });
    const parsed: EngineDocument = readEngineDocument(doc);
    expect(parsed.scan.limitations.metrics_are_estimates).toBe(true);
    expect(parsed.languages).toEqual([]);
  });
});

describe('parseEngineDocument', () => {
  it('parses the JSON text emitted by the engine', () => {
    const text = JSON.stringify(minimalDocument());
    expect(parseEngineDocument(text).files).toHaveLength(1);
  });

  it('reports invalid JSON as a ValidationError', () => {
    expect(() => parseEngineDocument('{ not json')).toThrow(ValidationError);
    expect(() => parseEngineDocument('')).toThrow(/invalid JSON/);
  });

  it('reports truncated output as a ValidationError', () => {
    const text = JSON.stringify(minimalDocument()).slice(0, 60);
    expect(() => parseEngineDocument(text)).toThrow(/invalid JSON/);
  });
});
