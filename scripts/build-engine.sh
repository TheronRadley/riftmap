#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Riftmap - native engine build
#
# Builds the Zig analysis engine in `engine/` and copies the resulting
# executable to a predictable location that the desktop app and the tests can
# resolve without guessing.
#
# Usage: bash scripts/build-engine.sh [Debug|ReleaseSafe|ReleaseFast|ReleaseSmall]
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_MODE="${1:-${RIFTMAP_ENGINE_BUILD_MODE:-ReleaseSafe}}"
ZIG_BIN="$(bash "$REPO_ROOT/scripts/setup-zig.sh" --print)"

echo "Building riftmap-engine ($BUILD_MODE) with $("$ZIG_BIN" version) ..."
cd "$REPO_ROOT/engine"
"$ZIG_BIN" build -Doptimize="$BUILD_MODE" -Dtarget=native

OUT="$REPO_ROOT/engine/zig-out/bin/riftmap-engine"
if [ ! -x "$OUT" ]; then
  echo "error: expected engine executable at $OUT" >&2
  exit 1
fi
echo "Engine built: $OUT"
"$OUT" --version
