#!/usr/bin/env bash
# Backpressure checks for startup-highlighting experiments.
# Keep this stricter than the benchmark: a perf win only counts if the normal
# typecheck and test suite still pass.
set -euo pipefail
bun run typecheck >/dev/null
bun test >/dev/null
