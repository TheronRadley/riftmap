#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Riftmap - fixture repository generator
#
# Creates small Git repositories with real commits and known contents under
# fixtures/generated/ (git-ignored). The tests and the benchmark harness use
# these so that every assertion runs against reproducible data.
#
# Usage: bash fixtures/scripts/make-fixtures.sh [output-directory]
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${1:-$REPO_ROOT/fixtures/generated}"
mkdir -p "$OUT"

# Deterministic commit metadata so that generated history is reproducible.
export GIT_AUTHOR_NAME="Fixture Author"
export GIT_AUTHOR_EMAIL="fixture-a@example.com"
export GIT_COMMITTER_NAME="Fixture Committer"
export GIT_COMMITTER_EMAIL="fixture-c@example.com"
export GIT_AUTHOR_DATE="2024-01-01T12:00:00+00:00"
export GIT_COMMITTER_DATE="2024-01-01T12:00:00+00:00"
export TZ=UTC

step() { printf '  -> %s\n' "$1"; }

init_repo() {
  local dir="$1"
  rm -rf "$dir"
  mkdir -p "$dir"
  git -C "$dir" init -q -b main
  git -C "$dir" config core.autocrlf false
  git -C "$dir" config user.name "Fixture Committer"
  git -C "$dir" config user.email "fixture-c@example.com"
}

commit() {
  local dir="$1"; shift
  local message="$1"; shift
  GIT_AUTHOR_DATE="${1:-2024-01-01T12:00:00+00:00}" GIT_COMMITTER_DATE="${1:-2024-01-01T12:00:00+00:00}" \
    git -C "$dir" add -A
  GIT_AUTHOR_DATE="${1:-2024-01-01T12:00:00+00:00}" GIT_COMMITTER_DATE="${1:-2024-01-01T12:00:00+00:00}" \
    git -C "$dir" commit -q -m "$message" --allow-empty
}

# ---------------------------------------------------------------------------
# 1. tiny-js - the primary end-to-end fixture
# ---------------------------------------------------------------------------
step "tiny-js"
TINY="$OUT/tiny-js"
init_repo "$TINY"
mkdir -p "$TINY/src/util" "$TINY/src/components" "$TINY/tests"

cat > "$TINY/package.json" <<'EOF'
{
  "name": "tiny-js",
  "version": "1.0.0",
  "private": true
}
EOF

cat > "$TINY/README.md" <<'EOF'
# tiny-js

A deliberately small fixture repository with known metrics.

- 6 source files
- `src/app.ts` is changed in every commit, so it is the clear hotspot
- `src/util/format.ts` is never touched after the first commit
EOF

cat > "$TINY/src/util/format.ts" <<'EOF'
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function formatCount(value: number): string {
  return String(value);
}
EOF

cat > "$TINY/src/util/parse.ts" <<'EOF'
import { formatBytes } from "./format";

export interface Options {
  verbose: boolean;
}

export function parse(input: string, options: Options): string[] {
  const parts: string[] = [];
  for (const piece of input.split(",")) {
    if (piece.length === 0) {
      continue;
    }
    if (options.verbose) {
      console.log(formatBytes(piece.length));
    }
    parts.push(piece.trim());
  }
  return parts;
}
EOF

cat > "$TINY/src/components/Button.tsx" <<'EOF'
import { formatCount } from "../util/format";

export function Button(props: { label: string; count: number }) {
  return {
    label: props.label,
    rendered: formatCount(props.count),
  };
}
EOF

cat > "$TINY/src/app.ts" <<'EOF'
import { parse } from "./util/parse";
import { formatBytes } from "./util/format";
import { Button } from "./components/Button";

export function main(input: string): string {
  const items = parse(input, { verbose: true });
  const summary = items.map((item) => formatBytes(item.length));
  return Button({ label: summary.join(","), count: items.length }).rendered;
}
EOF

cat > "$TINY/tests/app.test.ts" <<'EOF'
import { main } from "../src/app";

export function run(): boolean {
  return main("a,bb,ccc") === "3";
}
EOF

commit "$TINY" "initial import" "2024-01-01T09:00:00+00:00"

# src/app.ts is touched in every subsequent commit: it becomes the hotspot.
cat >> "$TINY/src/app.ts" <<'EOF'

export function extra(value: number): number {
  if (value > 10) {
    return value * 2;
  } else if (value < 0) {
    return 0;
  }
  return value;
}
EOF
commit "$TINY" "add extra helper to app" "2024-02-01T09:00:00+00:00"

cat >> "$TINY/src/app.ts" <<'EOF'

export function validate(value: number): boolean {
  for (let i = 0; i < value; i += 1) {
    if (i % 3 === 0 && i > 0) {
      return true;
    }
  }
  return false;
}
EOF
commit "$TINY" "add validation to app" "2024-03-01T09:00:00+00:00"

cat >> "$TINY/src/app.ts" <<'EOF'

export function summarise(values: number[]): number {
  let total = 0;
  while (values.length > 0) {
    const next = values.pop();
    total += next ?? 0;
  }
  return total;
}
EOF
commit "$TINY" "add summarise to app" "2024-04-01T09:00:00+00:00"

# A second contributor touches a different file.
GIT_AUTHOR_NAME="Second Author" GIT_AUTHOR_EMAIL="fixture-b@example.com" \
  commit "$TINY" "bump package version" "2024-05-01T09:00:00+00:00"

# ---------------------------------------------------------------------------
# 2. empty-repo - initialised but no commits
# ---------------------------------------------------------------------------
step "empty-repo"
EMPTY="$OUT/empty-repo"
init_repo "$EMPTY"
printf 'Untracked file with no history.\n' > "$EMPTY/untracked.txt"

# ---------------------------------------------------------------------------
# 3. non-git - an ordinary directory
# ---------------------------------------------------------------------------
step "non-git"
NONGIT="$OUT/non-git"
rm -rf "$NONGIT"
mkdir -p "$NONGIT/src"
printf 'export const hello = "world";\n' > "$NONGIT/src/hello.ts"
printf '# Not a repository\n' > "$NONGIT/README.md"

# ---------------------------------------------------------------------------
# 4. shallow-clone - depth 1 clone of tiny-js
# ---------------------------------------------------------------------------
step "shallow-clone"
rm -rf "$OUT/shallow-clone"
git clone -q --depth 1 "file://$TINY" "$OUT/shallow-clone" 2>/dev/null || {
  echo "warning: shallow clone failed, falling back to a normal clone" >&2
  git clone -q "file://$TINY" "$OUT/shallow-clone"
}

# ---------------------------------------------------------------------------
# 5. unsupported - only file types the engine does not track
# ---------------------------------------------------------------------------
step "unsupported"
UNSUP="$OUT/unsupported"
init_repo "$UNSUP"
mkdir -p "$UNSUP/bin"
printf '\x7fELF binary placeholder\n' > "$UNSUP/bin/app"
head -c 2048 /dev/urandom > "$UNSUP/data.bin"
printf 'not source at all\n' > "$UNSUP/notes.dat"
commit "$UNSUP" "binary only repository" "2024-01-01T09:00:00+00:00"

# ---------------------------------------------------------------------------
# 6. malformed - hostile inputs
# ---------------------------------------------------------------------------
step "malformed"
MAL="$OUT/malformed"
init_repo "$MAL"
mkdir -p "$MAL/src"

# Unterminated block comment.
cat > "$MAL/src/unterminated.ts" <<'EOF'
export const value = 1;
/* this comment never ends
export function broken(): number {
  return 2;
}
EOF

# Unterminated string literal.
cat > "$MAL/src/bad-string.ts" <<'EOF'
export const text = "this string never closes;
export const after = 3;
EOF

# Empty file.
: > "$MAL/src/empty.ts"

# File with no trailing newline and CRLF line endings.
printf 'export const a = 1;\r\nexport const b = 2;' > "$MAL/src/crlf.ts"

# A file containing invalid UTF-8 bytes.
printf 'export const raw = "\xff\xfe";\n' > "$MAL/src/invalid-utf8.ts"

# A very deeply nested file.
python3 - <<'PY' > "$MAL/src/deep.ts"
print("export function deep() {")
for _ in range(40):
    print("  {")
print("  return 1;")
for _ in range(40):
    print("  }")
print("}")
PY

# A normal file so the repository still has healthy signal.
cat > "$MAL/src/ok.ts" <<'EOF'
export function ok(value: number): number {
  if (value > 0) {
    return value;
  }
  return -value;
}
EOF

# A file that is committed and then made unreadable on disk. When the fixture
# runs as root the file stays readable (root bypasses permission bits), so the
# test asserts "no crash" rather than a specific skip count.
printf 'export const secret = 1;\n' > "$MAL/src/no-read-permission.ts"

commit "$MAL" "add malformed sources" "2024-01-01T09:00:00+00:00"
chmod 000 "$MAL/src/no-read-permission.ts" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 7. many-files - volume fixture
# ---------------------------------------------------------------------------
step "many-files"
MANY="$OUT/many-files"
init_repo "$MANY"
python3 - "$MANY" <<'PY'
import os, random, sys
root = sys.argv[1]
random.seed(1234)
count = 0
for package_index in range(12):
    package = f"packages/pkg{package_index:02d}"
    os.makedirs(os.path.join(root, package, "src"), exist_ok=True)
    for file_index in range(60):
        name = f"module{file_index:03d}.ts"
        path = os.path.join(root, package, "src", name)
        lines = []
        lines.append(f'import {{ helper }} from "../../../shared/helper";')
        lines.append("")
        branches = random.randint(0, 8)
        lines.append(f"export function fn{file_index:03d}(input: number): number {{")
        for b in range(branches):
            lines.append(f"  if (input === {b}) {{")
            lines.append(f"    return helper({b});")
            lines.append("  }")
        lines.append("  return 0;")
        lines.append("}")
        with open(path, "w") as handle:
            handle.write("\n".join(lines) + "\n")
        count += 1
os.makedirs(os.path.join(root, "shared"), exist_ok=True)
with open(os.path.join(root, "shared", "helper.ts"), "w") as handle:
    handle.write("export function helper(value: number): number {\n  return value * 2;\n}\n")
print(f"wrote {count} files")
PY
commit "$MANY" "generate many files" "2024-01-01T09:00:00+00:00"

# ---------------------------------------------------------------------------
# 8. weird-paths - spaces and non-ASCII characters
# ---------------------------------------------------------------------------
step "weird paths"
WEIRD="$OUT/weird paths — ünïcodé"
rm -rf "$WEIRD"
mkdir -p "$WEIRD"
git -C "$WEIRD" init -q -b main
git -C "$WEIRD" config user.name "Fixture Committer"
git -C "$WEIRD" config user.email "fixture-c@example.com"
mkdir -p "$WEIRD/src with spaces/ünïcodé"
cat > "$WEIRD/src with spaces/ünïcodé/café.ts" <<'EOF'
export const café = "naïve";
export function grüßen(): string {
  return café;
}
EOF
printf '# Weird paths\n\nSpaces and non-ASCII characters everywhere.\n' > "$WEIRD/README.md"
commit "$WEIRD" "add unicode sources" "2024-01-01T09:00:00+00:00"

# ---------------------------------------------------------------------------
# 9. python-mixed - Python import graph
# ---------------------------------------------------------------------------
step "python-mixed"
PYFIX="$OUT/python-mixed"
init_repo "$PYFIX"
mkdir -p "$PYFIX/pkg/sub"

cat > "$PYFIX/pkg/__init__.py" <<'EOF'
"""Package docstring used by the fixture."""

from .core import run

__all__ = ["run"]
EOF

cat > "$PYFIX/pkg/core.py" <<'EOF'
import os
from .sub.helpers import normalise

def run(path: str) -> list[str]:
    """Load and normalise every name in a directory."""
    names = []
    for entry in os.listdir(path):
        if entry.startswith("."):
            continue
        names.append(normalise(entry))
    return names
EOF

cat > "$PYFIX/pkg/sub/__init__.py" <<'EOF'
EOF

cat > "$PYFIX/pkg/sub/helpers.py" <<'EOF'
import re

def normalise(name: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", name.lower())
    return cleaned.strip("-")
EOF

cat > "$PYFIX/main.py" <<'EOF'
#!/usr/bin/env python3
"""Entry point for the fixture package."""
import sys
from pkg import run

def main(argv=None):
    argv = argv or sys.argv[1:]
    target = argv[0] if argv else "."
    for name in run(target):
        print(name)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
EOF

commit "$PYFIX" "add python package" "2024-01-01T09:00:00+00:00"
cat >> "$PYFIX/pkg/core.py" <<'EOF'


def count(path: str) -> int:
    return len(run(path))
EOF
commit "$PYFIX" "add count helper" "2024-02-01T09:00:00+00:00"

# ---------------------------------------------------------------------------
# 10. large-file - a source file above the default size limit
# ---------------------------------------------------------------------------
step "large-file"
LARGE="$OUT/large-file"
init_repo "$LARGE"
python3 - "$LARGE" <<'PY'
import os, sys
root = sys.argv[1]
target = os.path.join(root, "generated.ts")
with open(target, "w") as handle:
    handle.write("export const table: number[] = [\n")
    for i in range(200_000):
        handle.write(f"  {i},\n")
    handle.write("];\n")
print("wrote", os.path.getsize(target), "bytes")
PY
commit "$LARGE" "add generated table" "2024-01-01T09:00:00+00:00"

printf '\nFixtures written to %s\n' "$OUT"
ls -1 "$OUT"
