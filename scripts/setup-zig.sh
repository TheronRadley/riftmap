#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Riftmap - Zig toolchain bootstrap
#
# Installs a pinned Zig compiler into <repo>/.tools (git-ignored) so that the
# native engine can be built reproducibly without a system-wide install.
#
# The official Zig tarballs live on ziglang.org, which some restricted
# environments cannot reach. The `ziglang` PyPI wheel is published by the Zig
# project and bundles the exact same compiler, so we prefer it as the primary
# source and fall back to a direct tarball download when PyPI is unavailable.
#
# Usage:
#   bash scripts/setup-zig.sh            # install if missing, print path
#   bash scripts/setup-zig.sh --check    # only verify / print path
#   bash scripts/setup-zig.sh --print    # print the zig executable path only
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="$REPO_ROOT/.tools"
VENV_DIR="$TOOLS_DIR/zig-venv"
ZIG_VERSION="${RIFTMAP_ZIG_VERSION:-0.13.0}"

MODE="install"
case "${1:-install}" in
  --check) MODE="check" ;;
  --print) MODE="print" ;;
  install) MODE="install" ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

find_zig() {
  local candidates=(
    "$VENV_DIR/lib/python"*/site-packages/ziglang/zig
    "$VENV_DIR/Lib/site-packages/ziglang/zig.exe"
    "$VENV_DIR/lib/site-packages/ziglang/zig"
    "$VENV_DIR/bin/zig"
    "$VENV_DIR/Scripts/zig.exe"
    "$TOOLS_DIR/zig/zig"
    "$TOOLS_DIR/zig/zig.exe"
    "$TOOLS_DIR/ziglang/zig"
    "$TOOLS_DIR/ziglang/zig.exe"
  )
  for c in "${candidates[@]}"; do
    if [ -x "$c" ]; then
      printf '%s\n' "$c"
      return 0
    fi
  done
  # A system-installed zig also satisfies the requirement.
  if command -v zig >/dev/null 2>&1; then
    command -v zig
    return 0
  fi
  return 1
}

if ZIG_BIN="$(find_zig)"; then
  if [ "$MODE" = "print" ]; then
    printf '%s\n' "$ZIG_BIN"
    exit 0
  fi
  echo "zig found: $ZIG_BIN ($("$ZIG_BIN" version))"
  if [ "$MODE" = "check" ]; then
    exit 0
  fi
  # Already installed - verify the version matches the pin when it is our own.
  case "$ZIG_BIN" in
    "$TOOLS_DIR"/*)
      installed="$("$ZIG_BIN" version)"
      if [ "$installed" != "$ZIG_VERSION" ]; then
        echo "warning: pinned version is $ZIG_VERSION but $installed is installed" >&2
      fi
      ;;
  esac
  exit 0
fi

if [ "$MODE" = "check" ]; then
  echo "error: no zig compiler found. Run 'npm run zig:setup' first." >&2
  exit 1
fi

PYTHON="$(command -v python3 || command -v python)"
if [ -z "$PYTHON" ]; then
  echo "error: python3 is required to bootstrap the Zig toolchain" >&2
  exit 1
fi

mkdir -p "$TOOLS_DIR"

# The venv layout differs between POSIX and Windows, so locate the interpreter
# by trying both rather than assuming `bin/python`.
venv_python() {
  if [ -x "$VENV_DIR/bin/python" ]; then printf '%s\n' "$VENV_DIR/bin/python"; return 0; fi
  if [ -x "$VENV_DIR/Scripts/python.exe" ]; then printf '%s\n' "$VENV_DIR/Scripts/python.exe"; return 0; fi
  if [ -x "$VENV_DIR/bin/python3" ]; then printf '%s\n' "$VENV_DIR/bin/python3"; return 0; fi
  return 1
}

echo "Installing zig $ZIG_VERSION into $VENV_DIR ..."
if "$PYTHON" -m venv "$VENV_DIR" >/dev/null 2>&1 \
   && VENV_PYTHON="$(venv_python)" \
   && "$VENV_PYTHON" -m pip install --quiet --disable-pip-version-check "ziglang==$ZIG_VERSION"; then
  echo "Installed via the ziglang PyPI wheel."
else
  echo "PyPI install failed; falling back to a direct tarball download..." >&2
  case "$(uname -s)" in
    Linux)  PLATFORM="linux-$(uname -m)" ;;
    Darwin) PLATFORM="macos-$(uname -m)" ;;
    MINGW* | MSYS* | CYGWIN*) PLATFORM="windows-x86_64" ;;
    *) echo "error: unsupported platform $(uname -s) for the tarball fallback" >&2; exit 1 ;;
  esac
  TARBALL="zig-$PLATFORM-$ZIG_VERSION.tar.xz"
  URL="https://ziglang.org/download/$ZIG_VERSION/$TARBALL"
  TMP="$(mktemp -d)"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$URL" -o "$TMP/$TARBALL"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$URL" -O "$TMP/$TARBALL"
  else
    echo "error: neither curl nor wget is available" >&2
    exit 1
  fi
  mkdir -p "$TOOLS_DIR/zig"
  tar -xJf "$TMP/$TARBALL" -C "$TOOLS_DIR/zig" --strip-components=1
  rm -rf "$TMP"
fi

ZIG_BIN="$(find_zig || true)"
if [ -z "$ZIG_BIN" ]; then
  echo "error: zig install completed but no executable was found" >&2
  exit 1
fi
echo "zig ready: $ZIG_BIN ($("$ZIG_BIN" version))"
