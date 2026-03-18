#!/usr/bin/env bash
set -euo pipefail

typecheck_log=$(mktemp)
test_log=$(mktemp)
cleanup() {
  rm -f "$typecheck_log" "$test_log"
}
trap cleanup EXIT

bun run typecheck >"$typecheck_log" 2>&1 || {
  tail -n 120 "$typecheck_log"
  exit 1
}

bun test >"$test_log" 2>&1 || {
  tail -n 120 "$test_log"
  exit 1
}
