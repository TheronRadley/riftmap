# Riftmap

**See where your codebase is under pressure.**

Riftmap is a local-first desktop app that reads a local Git repository and shows
its structure, complexity, dependencies, change activity and maintenance
hotspots. A native **Zig** engine scans the source tree; the installed **`git`**
executable supplies the history. The shell is Electron + React + TypeScript.

Everything runs on your machine. Riftmap makes no network requests, sends no
telemetry, and never writes to a repository it analyses.

> Riftmap reports what it measured. It does not predict bugs, and it never
> presents activity, complexity or line counts as defect counts. Where a metric
> could not be measured, Riftmap says so instead of filling in a zero.

---

## 1. Features

| View | What it shows |
| --- | --- |
| **Overview** | File, line, language, dependency and commit totals, plus an explicit data-coverage report. |
| **Hotspot Explorer** | Scatter plot of change frequency against estimated complexity, bubble area by file size, colour by attention score, with a full score breakdown and an equivalent table. |
| **Dependency graph** | Resolved imports between files (Cytoscape.js), pan/zoom/drag/select, search, filters, node size by connection count, bounded subgraph for large repositories. |
| **Codebase treemap** | Nested directory treemap sized by source bytes, drill-down, breadcrumbs, language/directory filters. |
| **Files** | Sortable, searchable table of every scanned file with the inspector panel and a bounded source preview. |
| **History** | Commits and churn over time, contributors, most-changed files, and windows of 30 / 90 / 180 days / all. |

## 2. Quick start

```bash
git clone <this-repo> riftmap && cd riftmap

npm install                  # installs workspaces (see note below)
npm run zig:setup            # downloads the Zig 0.13.0 toolchain (local, git-ignored)
npm run engine:build         # compiles the native engine
npm run fixtures             # generates the test fixture repositories
npm run web                  # browser preview on http://localhost:5173
npm run dev                  # Electron shell (needs the Electron binary)
```

Requirements: Node >= 20, Git >= 2.15, and a C toolchain for the Zig linker.
`npm run zig:setup` installs Zig from the official [`ziglang` PyPI
wheel](https://pypi.org/project/ziglang/) into `.tools/`; nothing is installed
system-wide.

> **Electron binary.** On networks that block the Electron download, install
> with `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install`. `npm run dev` will then
> fail to launch the shell; `npm run web` still gives you the full app in a
> browser, backed by the same Zig engine and the same Git calls.

## 3. Architecture

```
┌──────────────────────── Electron main process (Node) ────────────────────────┐
│  electron/main         hardened BrowserWindow, native folder picker,          │
│                        validated IPC handlers, bounded file previews          │
│  @riftmap/analysis     orchestration: run engine + git, validate, combine     │
│  @riftmap/git-analysis read-only `git` via safe spawn (argument arrays)       │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │  subprocess (stdio / CLI args)
                                │  stdout: JSON only · stderr: progress + diagnostics
                    ┌───────────▼────────────┐
                    │  riftmap-engine (Zig)  │  recursive scan, lexical metrics,
                    │  standalone CLI        │  import extraction, versioned JSON
                    └────────────────────────┘

┌──────────────────────── Renderer (React, sandboxed) ─────────────────────────┐
│  contextIsolation on · nodeIntegration off · sandbox on                      │
│  only `window.riftmap` from the preload's contextBridge                      │
│  @riftmap/shared   domain model, validation, scoring, treemap layout         │
└──────────────────────────────────────────────────────────────────────────────┘
```

The renderer has no filesystem access, no `require`, and no `child_process`. It
can only call the typed methods on `window.riftmap` (see
`apps/desktop/shared/ipc.ts`), and every one of those validates its arguments
in the main process.

## 4. Directory structure

```
riftmap/
├── engine/                     Zig native engine
│   ├── build.zig
│   └── src/
│       ├── main.zig            CLI: flags, exit codes, --schema, --version
│       ├── analyze.zig         recursive traversal, per-file records, warnings
│       ├── metrics.zig         line counts, lexical complexity, nesting
│       ├── imports.zig         import extraction (JS / TS / Python)
│       ├── resolve.zig         specifier -> file resolution
│       ├── language.zig        extension and dialect table
│       ├── lexer.zig           shared lexical scanner
│       ├── ignore.zig          ignore rules (root .gitignore)
│       └── json_output.zig     deterministic, versioned JSON emitter
├── packages/
│   ├── shared/                 domain model, validation, scoring, treemap, windowing
│   ├── git-analysis/           safe `git` spawn + history parsing
│   └── analysis/               engine runner + orchestration
├── apps/desktop/
│   ├── electron/main/          main process
│   ├── electron/preload/       contextBridge API
│   ├── shared/ipc.ts           the typed IPC contract
│   └── src/                    React views and components
├── fixtures/scripts/           generates the E2E fixture repositories
├── benchmarks/                 measured throughput and memory harness
└── scripts/                    Zig setup, engine build, engine tests
```

## 5. Build and run commands

| Command | What it does |
| --- | --- |
| `npm run zig:setup` | Installs Zig 0.13.0 into `.tools/` (once). |
| `npm run engine:build` | Builds `engine/zig-out/bin/riftmap-engine` (ReleaseSafe). |
| `npm run engine:test` | Runs the Zig unit tests. |
| `npm run fixtures` | Regenerates the fixture repositories. |
| `npm run typecheck` | `tsc -b` across every workspace package. |
| `npm test` | Vitest: shared, git-analysis and analysis (incl. end-to-end fixtures). |
| `npm run web` | Vite dev server on `0.0.0.0:5173` — full app in a browser. |
| `npm run dev` | Bundles main/preload, starts Vite, launches Electron. |
| `npm run build` | Vite renderer build + esbuild main/preload bundles. |
| `npm run dist` | `npm run build` then `electron-builder` packaging. |
| `npm run engine:bench` | Runs the benchmark harness, writes `benchmarks/RESULTS.md`. |

## 6. Using the Zig engine on its own

The engine is a normal standalone CLI: JSON on stdout, diagnostics on stderr.

```bash
./engine/zig-out/bin/riftmap-engine --pretty /path/to/repo
./engine/zig-out/bin/riftmap-engine --ignore dist --ignore '*.generated.ts' /path/to/repo
./engine/zig-out/bin/riftmap-engine --max-file-bytes 1048576 --large-file-mode skip /path/to/repo
./engine/zig-out/bin/riftmap-engine --no-imports --no-complexity /path/to/repo
./engine/zig-out/bin/riftmap-engine --out report.json --progress /path/to/repo
./engine/zig-out/bin/riftmap-engine --schema      # prints the JSON contract
./engine/zig-out/bin/riftmap-engine --version
```

Exit codes: `0` success, `1` usage error, `2` fatal error, `3` completed but
truncated by a safety limit. Progress and fatal diagnostics are newline-delimited
JSON objects on stderr (`{"type":"progress",…}`, `{"type":"fatal",…}`); stdout
carries the JSON document and nothing else.

## 7. JSON schema

`schemaVersion: 2`. The only camelCase key is the top-level `schemaVersion`;
every other key is snake_case. Abridged:

```jsonc
{
  "schemaVersion": 2,
  "engine":   { "name", "version", "zig_version", "build_mode" },
  "scan":     { "root", "started_at_ms", "duration_ms", "options": { … },
                "limitations": { "metrics_are_estimates", "nested_ignore_files_supported",
                                 "import_languages", "unknown_language_complexity" } },
  "summary":  { "file_count", "directory_count", "total_bytes", "total_lines",
                "code_lines", "blank_lines", "comment_lines", "language_count",
                "edge_count", "resolved_edge_count", "external_edge_count",
                "unresolved_edge_count", "files_with_complexity", "files_with_imports",
                "files_skipped_large", "files_skipped_ignored", "files_skipped_unreadable",
                "files_skipped_unsupported", "directories_skipped", "symlinks_skipped",
                "truncated", "elapsed_ms" },
  "languages": [{ "id", "name", "file_count", "bytes", "code_lines", "total_lines",
                  "complexity_supported", "imports_supported" }],
  "directories": [{ "path", "name", "file_count", "bytes", "code_lines", "total_lines" }],
  "files": [{ "path", "ext", "language", "language_name", "bytes", "lines",
              "code_lines", "blank_lines", "comment_lines", "cyclomatic",
              "branch_count", "loop_count", "logical_count", "max_nesting",
              "function_count", "token_count", "content_scanned",
              "complexity_available", "imports_available",
              "import_count", "resolved_import_count" }],
  "edges": [{ "from", "to", "raw", "kind", "confidence", "line" }],
  "warnings": [{ "code", "message", "path" }],
  "errors": []
}
```

Run `--schema` for the full contract, including the precise definition of every
field and the documented limitations.

## 8. Metric definitions

| Metric | Definition |
| --- | --- |
| **Physical lines** (`lines`) | Number of line terminators, counting a final unterminated line. |
| **Code lines** | Physical lines that are neither blank nor (for the detected dialect) comment-only. |
| **Blank lines** | Lines that are empty or whitespace-only. |
| **Comment lines** | Lines whose first non-whitespace token starts a comment for the detected dialect. Block comments are counted per line they span. |
| **Cyclomatic complexity** | `1 + decision points`, where decision points are lexical matches for branch keywords (`if`, `else if`, `case`, `catch`, `?`), loop keywords (`for`, `while`, `do`), and logical operators (`&&`, `\|\|`, `??`). |
| **Branch / loop / logical counts** | The individual tallies that make up the complexity figure. |
| **Max nesting** | Greatest observed brace/indent nesting depth. |
| **Function count** | Lexical approximation: matches `function`, `def`, method signatures and arrow functions. Constructors, generators, decorators and unusual formatting may be missed or over-counted. |
| **Token count** | Count of lexical tokens recognised by the scanner. |
| **Import extraction** | Static and dynamic imports for JavaScript/TypeScript (`import … from`, `require()`, `import()`, `export … from`) and Python (`import x`, `from x import y`, including relative `from . import`). |

**Limitations, stated plainly.** These are lexical estimates, not grammar
parses. Strings and comments are skipped, but the scanner does not understand
macros, template-generated code, decorators, conditional exports, or
re-exported namespaces. Complexity is not measured for languages the engine
does not model (Markdown, JSON, plain text, …); those files report
`"cyclomatic": null` and are excluded from complexity coverage rather than
being given a fabricated value.

**Resolution.** An edge is `resolved` only when the specifier maps to a file the
scan actually visited. Specifiers that clearly come from outside the repository
(`react`, `os`, …) are `external`; internal-looking specifiers that did not
match a scanned file are `unresolved`. Riftmap does not guess.

## 9. The attention score

Score range **0–100**, computed per repository, not against a global baseline.

| Component | Default weight | Normalisation |
| --- | --- | --- |
| Change frequency | 40% | Percentile of commits in the selected window |
| Estimated complexity | 35% | Percentile of cyclomatic complexity, ranked **within the file's language** |
| File size | 15% | Percentile of source bytes |
| Contributor concentration | 10% | Normalised entropy of authorship (1 = one author did everything) |

Each component is ranked against the other files in the same repository, so a
score of 80 means "high relative to this codebase", not "objectively bad".

**Missing data is never treated as zero.** If a component cannot be measured —
no Git history in the window, or a language without complexity support — that
component is dropped and its weight is redistributed proportionally across the
remaining ones. Every file carries the full breakdown (weight, applied weight,
normalised value, raw value, contribution) and the inspector shows it.

**Labels are neutral by design:** `High attention` (>= 66), `Moderate
attention` (>= 33), `Lower attention`. These describe where change and
complexity coincide. They are **not** predictions of defects, bug density, or
code quality, and Riftmap never claims they are.

Complexity is ranked per-language because a 300-line TypeScript file and a
300-line Python file are not directly comparable; this is a deliberate
correction, not a fudge.

## 10. Testing

```bash
npm run engine:test    # 62 Zig unit tests
npm test               # 113 TypeScript tests (5 files)
```

What is actually covered:

* **Zig unit tests (62)** — line counting, comment handling, complexity
  counting, nesting, import extraction for JS/TS/Python, specifier resolution,
  language detection, JSON emission and truncation behaviour.
* **TypeScript unit tests (59)** — scoring (percentiles, weight redistribution,
  per-language normalisation, contribution sums), treemap layout
  (non-overlap, area conservation, degenerate rectangles, directory roll-up),
  and engine-schema validation (bad schema version, malformed JSON, unknown
  enum values, dotted error paths).
* **End-to-end fixtures (54)** — real Git repositories generated by
  `fixtures/scripts/make-fixtures.sh`, run through the real Zig engine and the
  real `git` executable:
  * `tiny-js` — dependency resolution, per-file change counts, coverage
  * `empty-repo` — repository with no commits
  * `non-git` — a directory that is not a repository (and one nested inside a
    repository, which Riftmap refuses to attribute to its parent)
  * `shallow-clone` — depth-1 clone, history reported as truncated
  * `unsupported` — only non-source files, zero files scanned
  * `malformed` — unterminated strings, invalid UTF-8, CRLF, deeply nested
    blocks, an empty file and an unreadable file
  * `many-files` — 720 source files with 720 resolved imports
  * `weird paths — ünïcodé` — spaces and non-ASCII in paths
  * `python-mixed` — relative and absolute Python imports
  * `large-file` — a ~1.9 MB file, tested both fully scanned and size-limited

  Plus engine-runner behaviour: missing repository, non-directory path,
  cancellation, progress events, size limits and `--large-file-mode`.

All of the above were run successfully on this branch. See
[§14](#14-what-was-actually-run) for the exact output.

## 11. Benchmarks

```bash
npm run engine:bench            # generated corpora
npm run engine:bench /path/repo # plus one real repository
```

Results are written to `benchmarks/RESULTS.md`. Measured on this branch
(Linux x86_64, 2 CPUs, ReleaseSafe build, cold-ish disk cache):

| Corpus | Files | Source size | Wall time | Files/sec | MiB/sec | Peak RSS |
| --- | --- | --- | --- | --- | --- | --- |
| small (500 files) | 501 | 0.4 MiB | 0.121 s | 4,157 | 3.0 | 10.3 MiB |
| medium (5000 files) | 5,001 | 5.3 MiB | 1.084 s | 4,613 | 4.9 | 11.5 MiB |

These are single-run wall-clock measurements of the native scanner on a
2-CPU sandbox. They are reported exactly as observed: no smoothing, no
extrapolation, no comparison against any other tool, and no fabricated
speedup percentages. Peak RSS comes from `getrusage(RUSAGE_CHILDREN)`; if a
platform does not expose it the column reads "not measured" instead of a guess.

## 12. Security and privacy

* **No unrestricted filesystem access.** The renderer gets `window.riftmap`
  only. There is no generic read/write channel and no shell channel.
* **No shell injection.** Every process is spawned with discrete argument
  arrays. Riftmap never builds a command string from a repository path.
* **Path traversal is refused.** File previews resolve the repository-relative
  path and reject anything that escapes the repository root.
* **Scanned code is never executed.** Previews are read as text, capped at
  512 KiB / 4000 lines, and refused for binary content. Riftmap never imports,
  evaluates or runs anything it finds in a repository.
* **Read-only.** All Git invocations are read-only (`log`, `rev-parse`,
  `rev-list`, `status`). Riftmap never commits, checks out or cleans.
* **Local only.** No network requests, no telemetry, no crash reporting, no
  analytics. The Content-Security-Policy blocks everything but the app's own
  origin, and `setWindowOpenHandler` denies new windows.
* **Hardened window.** `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, `webSecurity: true`, no `<webview>`, no remote module.

## 13. Known limitations

* **Shallow clones** report only the commits they contain; Git history
  coverage is reduced and the UI says so.
* **Nested `.gitignore` files are not honoured** — only the repository-root
  ignore file is read. This is reported in `scan.limitations`.
* **Symlinks are skipped** and counted, never followed.
* **Binary and very large files** are excluded from content scanning by
  default (8 MiB); with `--large-file-mode count_lines` only the physical line
  count is collected.
* **Import resolution is static.** Path aliases (`@/…`), `tsconfig` `paths`,
  build-time code generation and dynamic specifiers built at runtime will show
  up as `unresolved` rather than being guessed.
* **Complexity and dependency graphs are estimates.** See §8.
* **Commit retrieval is capped** at 20,000 commits by default; hitting the cap
  sets `truncated` and the UI flags it.
* **The Electron binary could not be downloaded in the build sandbox**, so the
  packaged app has not been launched here. The renderer was verified through
  `tsc -b`, a production Vite build, and the browser preview (`npm run web`),
  which runs the identical pipeline against the same engine and Git.
* **Packaging is configured but untested** on macOS and Windows targets.
* **macOS builds of the engine are not verified in CI.** Zig 0.13.0 cannot link
  its own build runner against the macOS 15 SDK on GitHub's arm64 images —
  `zig build` fails with undefined `_getenv` / `_getcwd` / `_free` from
  libSystem before any Riftmap code is compiled. The `macos-13` image carries a
  compatible SDK but its runner pool no longer starts. CI therefore verifies the
  engine on **Linux and Windows only** (both green); macOS is documented as
  unverified rather than reported as passing. Building on a local Mac works
  once a compatible SDK is selected.

## 14. What was actually run

```
$ zig build test --summary all
Build Summary: 4/4 steps succeeded; 62/62 tests passed

$ npx tsc -b packages/shared packages/git-analysis packages/analysis apps/desktop
(clean, no output)

$ npx vitest run
 ✓ packages/analysis/src/index.test.ts      (31 tests)
 ✓ packages/git-analysis/src/index.test.ts  (28 tests)
 ✓ packages/shared/src/score.test.ts        (25 tests)
 ✓ packages/shared/src/treemap.test.ts      (18 tests)
 ✓ packages/shared/src/engine-schema.test.ts (11 tests)
 Test Files  5 passed (5)
      Tests  113 passed (113)

$ bash benchmarks/run.sh
| small (500 files)   |   501 | 0.4 MiB | 0.121 s | 4,157 | 3.0 | 10.3 MiB |
| medium (5000 files) | 5,001 | 5.3 MiB | 1.084 s | 4,613 | 4.9 | 11.5 MiB |

$ npx vite build   (apps/desktop)
✓ 854 modules transformed  →  out/renderer/ (991 kB JS, 20 kB CSS)
$ node scripts/build-electron.mjs
  out/main/index.js    65.6kb
  out/preload/index.js  1.1kb
```

### Failures encountered and fixed along the way

* `npm install` fails at the Electron postinstall without
  `ELECTRON_SKIP_BINARY_DOWNLOAD=1` (TLS certificate verification in the
  sandbox). Worked around; documented in §2.
* `git log --numstat -z` terminates the pretty-format header with **NUL**, not
  newline, so the original parser left a trailing `\0` on every commit subject
  and produced zero file entries. Fixed in `parseLog`/`parseNumStat`, with
  regression tests.
* `--show-toplevel` walks *up* the tree, so a plain directory inside a
  repository silently inherited that repository's history. Riftmap now refuses
  and explains how to open the repository root.
* A zero-byte source file reported `"cyclomatic": null`; it now reports `1`
  (zero decision points), because the value is well defined.
* The `many-files` fixture imported `../../shared/helper` from
  `packages/pkgNN/src/`, which resolved to the wrong directory; corrected to
  `../../../shared/helper` so all 720 imports resolve.
* `tsc` errors from `ChildProcessByStdio`, implicit `any` on the `close`
  handler, and `process.resourcesPath` — all fixed rather than suppressed.
* The first treemap `squarify` implementation double-pushed cells and
  re-indexed with `indexOf` (O(n²), wrong coordinates). Rewritten with a
  closed-form aspect-ratio test.
* The renderer initially imported `@riftmap/analysis`, which pulled
  `node:child_process` into the browser bundle. The pure windowing, re-scoring
  and coverage code moved to `@riftmap/shared`.
* Tailwind's `content` globs resolved against the process CWD rather than the
  package, producing an empty stylesheet when built from the repository root;
  now absolute.
* `engine/build.zig.zon` listed `README.md` in `.paths` but the file did not
  exist — an invalid package manifest. The engine README now exists.
* CI: the Windows Zig bootstrap failed because the venv interpreter lives at
  `Scripts/python.exe`, not `bin/python`; and the engine build failed on macOS
  arm64 (see §13). Windows is fixed; macOS is documented as unverified.
  `.gitattributes` now pins LF so the shell scripts survive a Windows checkout.

## 15. Roadmap / next improvements

* Honour nested `.gitignore` files (the limitation is already reported in the
  scan output and the UI).
* `tsconfig.json` `paths` and bundler alias support for import resolution.
* Incremental re-scan: reuse previous results for unchanged files.
* Export a report (JSON / HTML) from the UI.
* Per-file history sparklines in the inspector.

## License

MIT — see [LICENSE](LICENSE).
