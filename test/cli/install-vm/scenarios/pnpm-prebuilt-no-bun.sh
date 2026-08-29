#!/usr/bin/env bash
# shellcheck source=../guest/scenario-lib.sh
# shellcheck disable=SC1091,SC2154
source /tmp/hunk-install-vm/scenario-lib.sh
setup_profile
install_pnpm
current=$(curl -fsS "$HTTP_URL/fixture-manifest.json" | sed -n 's/.*"currentVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)

run_expect install-current 0 pnpm add -g "hunkdiff@$current"
run_expect version 0 hunk --version
assert_contains version-output "$command_dir/version.log" "$current"
run_expect help 0 hunk --help
assert_contains help-output "$command_dir/help.log" "Usage: hunk"
run_expect markup-guide 0 hunk markup guide
assert_contains markup-guide-output "$command_dir/markup-guide.log" "STML"
run_expect dependency-tree 0 pnpm list -g --depth Infinity --json
# Locate the actual projected platform binary rather than trusting only the global shim.
resolved_binary=$(find "$HOME/pnpm" -path '*/hunkdiff-linux-x64/*/bin/hunk' -type f -print -quit 2>/dev/null)
record_observation hunkVersion "$current"
record_observation installSource pnpm-prebuilt
record_observation resolvedExecutable "$resolved_binary"
record_observation dependencyTreePath commands/dependency-tree.log
assert_tree_has_no_bun_packages no-bun-packages "$HOME/pnpm"
if command -v bun >/dev/null 2>&1; then
  record_assertion no-path-bun failed absent present "bun unexpectedly resolved on PATH"
else
  record_assertion no-path-bun passed absent absent "bun is not on PATH"
fi
scenario_finish
