# riftmap-engine

The native analysis engine for [Riftmap](../README.md). A standalone Zig
executable: it walks a repository, measures each source file, extracts imports,
and writes a versioned JSON document to **stdout**. Diagnostics (progress and
fatal errors) go to **stderr**, so stdout is always machine-readable.

It has no dependency on the desktop app. Anything that can spawn a process and
read JSON can use it.

## Build

```bash
bash ../scripts/setup-zig.sh     # installs Zig 0.13.0 into ../.tools
bash ../scripts/build-engine.sh  # -> engine/zig-out/bin/riftmap-engine
bash ../scripts/test-engine.sh   # runs the Zig unit tests
```

Or, with a system Zig >= 0.13.0:

```bash
cd engine && zig build -Doptimize=ReleaseSafe
```

## Standalone CLI

```
riftmap-engine [options] <repo-path>
```

| Flag | Meaning |
| --- | --- |
| `-h`, `--help` | Usage text. |
| `--version` | Version, Zig version and schema version. |
| `--schema` | Print the JSON schema contract (see below). |
| `-o`, `--out <file>` | Write the document to a file instead of stdout. |
| `--pretty` | Indent the JSON with two spaces (otherwise compact). |
| `--progress` | Emit `{"type":"progress",…}` frames on stderr. |
| `--max-file-bytes <n>` | Skip content scanning above this size (default 8388608). |
| `--large-file-mode <mode>` | `skip` \| `count_lines` \| `full` (default `count_lines`). |
| `--max-files <n>` | Stop after this many files (default 200000). |
| `--max-depth <n>` | Maximum directory depth (default 64). |
| `--max-total-bytes <n>` | Stop once this much source has been read. |
| `--ignore <pattern>` | Extra ignore pattern; repeatable. |
| `--include-hidden` | Do not skip dot-files and dot-directories. |
| `--no-gitignore` | Ignore the repository-root `.gitignore`. |
| `--no-imports` | Skip import extraction. |
| `--no-complexity` | Skip complexity analysis. |

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. |
| `1` | Usage error (bad flag, missing path). |
| `2` | Fatal error: the repository could not be opened or scanned. |
| `3` | Completed but **truncated** by a safety limit. The document is still valid; `summary.truncated` is `true`. |

### stderr protocol

Progress frames (only with `--progress`, but always safe to ignore):

```json
{"type":"progress","stage":"scan","files":1204,"directories":88,"bytes":4821190,"elapsed_ms":73}
{"type":"done","files":1204,"edges":913,"elapsed_ms":88,"truncated":false}
```

Fatal errors:

```json
{"type":"fatal","code":"repo-not-found","message":"…","path":"…"}
```

## JSON contract (`schemaVersion: 2`)

The only camelCase key is the top-level `schemaVersion`; every other key is
`snake_case`.

```jsonc
{
  "schemaVersion": 2,
  "engine":  { "name", "version", "zig_version", "build_mode" },
  "scan":    { "root", "started_at_ms", "duration_ms", "options": { … },
               "limitations": { "metrics_are_estimates": true,
                                "nested_ignore_files_supported": false,
                                "import_languages": ["javascript","typescript","python"],
                                "unknown_language_complexity": "not analysed" } },
  "summary": { "file_count", "directory_count", "total_bytes", "total_lines",
               "code_lines", "blank_lines", "comment_lines", "language_count",
               "edge_count", "resolved_edge_count", "external_edge_count",
               "unresolved_edge_count", "files_with_complexity",
               "files_with_imports", "files_skipped_large",
               "files_skipped_ignored", "files_skipped_unreadable",
               "files_skipped_unsupported", "directories_skipped",
               "symlinks_skipped", "truncated", "elapsed_ms" },
  "languages":   [{ "id", "name", "file_count", "bytes", "code_lines",
                    "total_lines", "complexity_supported", "imports_supported" }],
  "directories": [{ "path", "name", "file_count", "bytes", "code_lines",
                    "total_lines" }],
  "files": [{ "path", "ext", "language", "language_name", "bytes", "lines",
              "code_lines", "blank_lines", "comment_lines", "cyclomatic",
              "branch_count", "loop_count", "logical_count", "max_nesting",
              "function_count", "token_count", "content_scanned",
              "complexity_available", "imports_available", "import_count",
              "resolved_import_count" }],
  "edges": [{ "from", "to", "raw", "kind", "confidence", "line" }],
  "warnings": [{ "code", "message", "path" }],
  "errors": []
}
```

* `files[].cyclomatic` is `null` when the language has no complexity model or
  the file was not content-scanned. Null means "not measured", never zero.
* `edges[].confidence` is `resolved` (both ends are scanned files), `external`
  (clearly outside the repository) or `unresolved` (internal-looking but no
  match). Riftmap does not guess.
* `warnings` are per-file or per-directory and non-fatal; the scan continues.
  They are capped at 2000 entries to bound memory.
* `errors` is reserved for fatal findings; a fatal error exits `2`.

Run `riftmap-engine --schema` for the complete, authoritative contract
including the precise definition of every field.

## Source layout

| File | Responsibility |
| --- | --- |
| `main.zig` | CLI parsing, exit codes, `--schema` / `--version`, output routing |
| `analyze.zig` | Recursive traversal, per-file records, warnings, limits |
| `metrics.zig` | Line classification, lexical complexity, nesting, token counts |
| `lexer.zig` | Shared lexical scanner (strings, comments, tokens) |
| `imports.zig` | Import extraction for JavaScript, TypeScript and Python |
| `resolve.zig` | Specifier to file resolution |
| `language.zig` | Extension and dialect table |
| `ignore.zig` | Ignore rules, including the repository-root `.gitignore` |
| `json_output.zig` | Deterministic, versioned JSON emitter |
| `root.zig` | Test entry point (`zig build test`) |

## Guarantees and limits

* One directory handle is open at a time; file records are streamed out, so the
  whole repository is never held in memory.
* Symlinks are counted and skipped, never followed.
* Unreadable, malformed, invalid-UTF-8 and very large files produce a warning
  and a metadata-only record instead of aborting the scan.
* Only the repository-root `.gitignore` is honoured; nested ignore files are
  not (reported in `scan.limitations`).
* Metrics are lexical estimates, not grammar parses. See the root README for the
  exact definitions.
