#!/usr/bin/env bash
#
# Riftmap benchmark harness.
#
# Measures the native engine only: wall time, files/sec, source bytes/sec and
# peak RSS, on a generated corpus and (optionally) on a real repository passed
# as an argument.
#
# Everything reported here is measured. Nothing is extrapolated, and no
# comparison against another tool is claimed.
#
# Usage:
#   bash benchmarks/run.sh                 # generated corpora only
#   bash benchmarks/run.sh /path/to/repo   # plus one real repository
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$REPO_ROOT/benchmarks/.work"
REPORT="$REPO_ROOT/benchmarks/RESULTS.md"
ENGINE="$REPO_ROOT/engine/zig-out/bin/riftmap-engine"

if [[ ! -x "$ENGINE" ]]; then
  echo "error: $ENGINE not found. Run: npm run engine:build" >&2
  exit 1
fi

mkdir -p "$WORK"

# ---------------------------------------------------------------------------
# Measurement helpers
# ---------------------------------------------------------------------------

# Timing and peak memory are measured by benchmarks/measure.py, which uses
# time.perf_counter() and getrusage(RUSAGE_CHILDREN) so the harness does not
# depend on GNU `/usr/bin/time` being installed.
measure() {
  local label="$1"
  local path="$2"
  local file_count="$3"
  local byte_count="$4"
  local stdout_file="$WORK/last-stdout.json"
  local stderr_file="$WORK/last-stderr.txt"

  python3 "$REPO_ROOT/benchmarks/measure.py" \
    "$ENGINE" "$path" "$stdout_file" "$stderr_file" \
    "$label" "$file_count" "$byte_count" "$REPORT"
}

count_corpus() {
  # Counts the files the engine will actually visit, so files/sec is honest:
  # the same ignore rules as a real scan (no .git, no hidden files).
  python3 - "$1" <<'PY'
import os, sys
root = sys.argv[1]
files = 0
bytes_ = 0
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if not d.startswith('.')]
    for name in filenames:
        if name.startswith('.'):
            continue
        full = os.path.join(dirpath, name)
        try:
            size = os.path.getsize(full)
        except OSError:
            continue
        files += 1
        bytes_ += size
print(files, bytes_)
PY
}

# ---------------------------------------------------------------------------
# Generated corpora
# ---------------------------------------------------------------------------

generate() {
  local name="$1"
  local files="$2"
  local lines="$3"
  local dir="$WORK/$name"
  rm -rf "$dir"
  python3 - "$dir" "$files" "$lines" <<'PY'
import os, random, sys
root, count, lines = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
random.seed(7)
os.makedirs(root, exist_ok=True)
packages = max(1, count // 120)
for index in range(count):
    package = f"pkg{index % packages:03d}"
    os.makedirs(os.path.join(root, package), exist_ok=True)
    body = []
    body.append(f'import {{ helper }} from "../shared/helper";')
    body.append("")
    body.append(f"export function fn{index:05d}(value: number): number {{")
    for line in range(max(0, lines - 4)):
        if line % 17 == 0:
            body.append(f"  if (value === {line}) {{")
            body.append(f"    return helper({line});")
            body.append("  }")
        elif line % 23 == 0:
            body.append(f"  for (let i = 0; i < {line % 7 + 1}; i += 1) {{")
            body.append("    value += i;")
            body.append("  }")
        else:
            body.append(f"  value += {line % 5};")
    body.append("  return value;")
    body.append("}")
    with open(os.path.join(root, package, f"m{index:05d}.ts"), "w") as handle:
        handle.write("\n".join(body) + "\n")
os.makedirs(os.path.join(root, "shared"), exist_ok=True)
with open(os.path.join(root, "shared", "helper.ts"), "w") as handle:
    handle.write("export function helper(value: number): number {\n  return value + 1;\n}\n")
PY
  echo "$dir"
}

echo "Riftmap benchmarks"
echo "=================="
echo
echo "Engine: $ENGINE"
"$ENGINE" --version | head -1
echo "Machine: $(uname -s) $(uname -m), $(nproc) CPUs"
echo "Memory: peak RSS via getrusage(RUSAGE_CHILDREN)"
echo

{
  echo "# Riftmap benchmarks"
  echo
  echo "Measured on $(date -u +'%Y-%m-%dT%H:%M:%SZ') with:"
  echo
  echo "\`$("$ENGINE" --version | head -1)\`"
  echo
  echo "- Machine: $(uname -s) $(uname -m), $(nproc) CPUs"
  echo "- Build: $(basename "$ENGINE") ($(python3 - "$ENGINE" <<'PY'
import subprocess, sys
try:
    out = subprocess.run([sys.argv[1], '--version'], capture_output=True, text=True).stdout
    print(out.strip().splitlines()[0] if out.strip() else 'unknown')
except Exception:
    print('unknown')
PY
))"
  echo "- Peak memory: \`getrusage(RUSAGE_CHILDREN)\` maximum resident set size for the engine process"
  echo "- Corpus: generated TypeScript files plus, when supplied, one real repository"
  echo
  echo "These are single-run wall-clock measurements of the native scanner only."
  echo "They are reported as observed; no speedup or comparison claim is made."
  echo
  echo "| Corpus | Files | Source size | Wall time | Files/sec | MiB/sec | Peak RSS |"
  echo "| --- | --- | --- | --- | --- | --- | --- |"
} > "$REPORT"

for spec in "small:500:40" "medium:5000:60"; do
  name="${spec%%:*}"
  rest="${spec#*:}"
  files="${rest%%:*}"
  lines="${rest##*:}"
  echo "Generating $name corpus ($files files, ~$lines lines each)…"
  dir="$(generate "$name" "$files" "$lines")"
  read -r counted counted_bytes <<<"$(count_corpus "$dir")"
  echo "Measuring $name…"
  measure "$name ($files files)" "$dir" "$counted" "$counted_bytes"
done

if [[ $# -ge 1 && -d "$1" ]]; then
  read -r counted counted_bytes <<<"$(count_corpus "$1")"
  echo "Measuring real repository: $1"
  measure "real repository ($(basename "$1"))" "$1" "$counted" "$counted_bytes"
elif [[ $# -ge 1 ]]; then
  echo "warning: '$1' is not a directory; skipping the real-repository measurement" >&2
fi

cat >> "$REPORT" <<'EOF'

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
EOF

echo
echo "Report written to $REPORT"
echo
cat "$REPORT"
