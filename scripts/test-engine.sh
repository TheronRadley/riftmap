#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Riftmap - native engine tests
#
# Runs `zig build test`, which executes every `test` block in the engine
# sources (unit tests for the lexer, line counting, import detection, path
# handling, ignore rules, aggregation and JSON emission).
#
# Optional args are forwarded to `zig build test`, e.g. `-- --summary all`.
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZIG_BIN="$(bash "$REPO_ROOT/scripts/setup-zig.sh" --print)"

cd "$REPO_ROOT/engine"
echo "Running engine unit tests with $("$ZIG_BIN" version) ..."
"$ZIG_BIN" build test "$@"
