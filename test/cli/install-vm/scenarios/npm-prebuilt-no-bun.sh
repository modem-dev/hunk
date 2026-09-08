#!/usr/bin/env bash
# shellcheck source=../guest/scenario-lib.sh
# shellcheck disable=SC1091,SC2154
source /tmp/hunk-install-vm/scenario-lib.sh
setup_profile
current=$(curl -fsS "$HTTP_URL/fixture-manifest.json" | sed -n 's/.*"currentVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)

run_expect install-current 0 npm install -g "hunkdiff@$current" --registry "$REGISTRY_URL"
run_expect version 0 hunk --version
assert_contains version-output "$command_dir/version.log" "$current"
run_expect help 0 hunk --help
assert_contains help-output "$command_dir/help.log" "Usage: hunk"
run_expect markup-guide 0 hunk markup guide
assert_contains markup-guide-output "$command_dir/markup-guide.log" "STML"
# Assert the launcher resolved the compiled platform package without installing any Bun package.
platform_binary="$npm_config_prefix/lib/node_modules/hunkdiff/node_modules/hunkdiff-linux-x64/bin/hunk"
assert_path_state platform-binary executable "$platform_binary"
run_expect dependency-tree 0 npm ls -g --all --json
record_observation hunkVersion "$current"
record_observation installSource npm-prebuilt
record_observation resolvedExecutable "$platform_binary"
record_observation dependencyTreePath commands/dependency-tree.log
assert_tree_has_no_bun_packages no-bun-packages "$npm_config_prefix"
if command -v bun >/dev/null 2>&1; then
  record_assertion no-path-bun failed absent present "bun unexpectedly resolved on PATH"
else
  record_assertion no-path-bun passed absent absent "bun is not on PATH"
fi
scenario_finish
