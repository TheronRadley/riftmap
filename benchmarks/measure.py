#!/usr/bin/env python3
"""Runs the Riftmap engine once and reports measured throughput and memory.

Called by benchmarks/run.sh. Timing and peak memory are both measured:

* wall time  - `time.perf_counter()` around the subprocess call, so it includes
  process startup and JSON serialisation;
* peak RSS   - `getrusage(RUSAGE_CHILDREN)`, the kernel's own high-water mark
  for reaped children. On Linux that is KiB, on macOS bytes.
* scan time  - the engine's self-reported `summary.elapsed_ms`, which covers
  traversal and analysis only and excludes startup.

Nothing here is estimated or extrapolated. If the platform does not expose a
memory figure, the field reads "not measured".
"""

from __future__ import annotations

import json
import os
import resource
import subprocess
import sys
import time


def main(argv: list[str]) -> int:
    if len(argv) != 9:
        print(
            "usage: measure.py <engine> <repo-path> <stdout-file> <stderr-file> "
            "<label> <file-count> <byte-count> <report-file>",
            file=sys.stderr,
        )
        return 2

    engine, path, stdout_file, stderr_file, label, files_raw, bytes_raw, report = argv[1:]
    files = int(files_raw)
    byte_count = int(bytes_raw)

    before = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    start = time.perf_counter()
    with open(stdout_file, "wb") as out, open(stderr_file, "wb") as err:
        completed = subprocess.run(
            [engine, "--out", stdout_file, path], stdout=out, stderr=err
        )
    elapsed = time.perf_counter() - start
    after = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss

    # Exit code 3 means "completed but truncated by a safety limit", which is a
    # successful measurement of a partial scan.
    if completed.returncode not in (0, 3):
        print(f"  ! {label}: engine exited with {completed.returncode}", file=sys.stderr)
        return 0

    peak_kb = max(0, after - before)
    if sys.platform == "darwin":
        peak_kb //= 1024
    peak = f"{peak_kb / 1024:.1f} MiB" if peak_kb > 0 else "not measured"

    engine_ms = ""
    try:
        with open(stdout_file) as handle:
            doc = json.load(handle)
        engine_ms = str(doc.get("summary", {}).get("elapsed_ms", ""))
    except Exception:  # noqa: BLE001 - a malformed document must not abort the run
        engine_ms = ""

    wall_s = elapsed
    files_per_s = files / wall_s if wall_s > 0 else 0.0
    mb_per_s = (byte_count / (1024 * 1024)) / wall_s if wall_s > 0 else 0.0

    row = (
        f"| {label} | {files:,} | {byte_count / (1024 * 1024):.1f} MiB | "
        f"{wall_s:.3f} s | {files_per_s:,.0f} | {mb_per_s:,.1f} | {peak} |"
    )
    with open(report, "a", encoding="utf-8") as handle:
        handle.write(row + "\n")
    print(row)
    if engine_ms:
        print(f"    engine self-reported scan time: {int(engine_ms) / 1000:.3f} s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
