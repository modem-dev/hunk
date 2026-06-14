#!/bin/bash
set -euo pipefail

bun run typecheck >/tmp/hunk-autoresearch-typecheck.log 2>&1 || {
  tail -80 /tmp/hunk-autoresearch-typecheck.log
  exit 1
}
