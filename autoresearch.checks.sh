#!/usr/bin/env bash
set -euo pipefail
bun run typecheck >/dev/null
bun test >/dev/null
