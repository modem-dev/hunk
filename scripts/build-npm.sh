#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
outdir="${repo_root}/dist/npm"

rm -rf "${outdir}"
mkdir -p "${outdir}/opentui"

BUN_TMPDIR="${repo_root}/.bun-tmp" \
BUN_INSTALL="${repo_root}/.bun-install" \
  bun build "${repo_root}/src/main.tsx" \
    --target bun \
    --format esm \
    --outdir "${outdir}" \
    --entry-naming main.js

chmod 0755 "${outdir}/main.js"

BUN_TMPDIR="${repo_root}/.bun-tmp" \
BUN_INSTALL="${repo_root}/.bun-install" \
  bun build "${repo_root}/src/opentui/index.ts" \
    --target node \
    --format esm \
    --external react \
    --external react/jsx-runtime \
    --external react/jsx-dev-runtime \
    --external @opentui/core \
    --external @opentui/react \
    --external @opentui/react/jsx-runtime \
    --external @opentui/react/jsx-dev-runtime \
    --external @pierre/diffs \
    --outdir "${outdir}/opentui" \
    --entry-naming index.js

bun x tsc -p "${repo_root}/tsconfig.opentui.json"

printf 'Built %s\n' "${outdir}/main.js"
printf 'Built %s\n' "${outdir}/opentui/index.js"
