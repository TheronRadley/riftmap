# Riftmap benchmarks

Measured on 2026-10-17T13:50:37Z with:

`riftmap-engine 0.1.0 (zig 0.13.0, schema 2)`

- Machine: Linux x86_64, 2 CPUs
- Build: riftmap-engine (riftmap-engine 0.1.0 (zig 0.13.0, schema 2))
- Peak memory: `getrusage(RUSAGE_CHILDREN)` maximum resident set size for the engine process
- Corpus: generated TypeScript files plus, when supplied, one real repository

These are single-run wall-clock measurements of the native scanner only.
They are reported as observed; no speedup or comparison claim is made.

| Corpus | Files | Source size | Wall time | Files/sec | MiB/sec | Peak RSS |
| --- | --- | --- | --- | --- | --- | --- |
| small (500 files) | 501 | 0.4 MiB | 0.121 s | 4,157 | 3.0 | 10.3 MiB |
| medium (5000 files) | 5,001 | 5.3 MiB | 1.084 s | 4,613 | 4.9 | 11.5 MiB |

## How to read these numbers

- **Wall time** is measured by the shell around the whole engine invocation, so
  it includes process startup and JSON serialisation. The engine's own
  self-reported `summary.elapsed_ms` (printed above each run) covers the
  traversal and analysis only.
- **Files/sec** and **MiB/sec** are derived from the wall time and the file
  count / byte count of the corpus as counted with the same ignore rules the
  engine uses. They are throughput observations, not a claim about correctness
  or about any other tool.
- **Peak RSS** is the maximum resident set size reported by the kernel for the
  engine process (via `getrusage(RUSAGE_CHILDREN)`). If the platform does not
  expose it, the column reads "not measured" rather than being guessed.
- Numbers vary with disk cache state, CPU frequency scaling and the machine's
  load. Run the harness a few times before drawing conclusions.
