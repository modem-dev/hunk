#!/usr/bin/env bash
# shellcheck source=../guest/scenario-lib.sh
# shellcheck disable=SC1091,SC2154
source /tmp/hunk-install-vm/scenario-lib.sh
setup_profile
install_pnpm
manifest=$(curl -fsS "$HTTP_URL/fixture-manifest.json")
version_a=$(printf '%s\n' "$manifest" | sed -n 's/.*"versionA"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
version_b=$(printf '%s\n' "$manifest" | sed -n 's/.*"versionB"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)

# Upgrade in place without pruning so both versions exercise the same shared virtual store.
run_expect install-a 0 pnpm add -g "hunkdiff@$version_a"
run_expect version-a 0 hunk --version
assert_contains installed-a "$command_dir/version-a.log" "$version_a"
run_expect upgrade-b 0 pnpm update -g hunkdiff --latest
run_expect version-b 0 hunk --version
assert_contains installed-b "$command_dir/version-b.log" "$version_b"
assert_not_contains no-stale-version "$command_dir/version-b.log" "$version_a"
record_observation hunkVersion "$version_b"
record_observation previousHunkVersion "$version_a"
record_observation installSource pnpm-prebuilt
assert_tree_has_no_bun_packages no-bun-packages "$HOME/pnpm"
find "$HOME/pnpm/store" -path '*/@oven/bun-*' -o -path '*/node_modules/bun' >"$artifact_dir/store-projection.txt" 2>/dev/null
record_observation storeProjectionPath store-projection.txt
run_expect dependency-tree 0 pnpm list -g --depth Infinity --json
record_observation dependencyTreePath commands/dependency-tree.log
if [[ -s $artifact_dir/store-projection.txt ]]; then
  record_assertion store-projection-clean failed empty nonempty "Bun entered pnpm store projection"
else
  record_assertion store-projection-clean passed empty empty "pnpm store projection contains no Bun package"
fi
scenario_finish
