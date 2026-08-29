#!/usr/bin/env bash
# shellcheck source=../guest/scenario-lib.sh
# shellcheck disable=SC1091,SC2154
source /tmp/hunk-install-vm/scenario-lib.sh
setup_profile
manifest=$(curl -fsS "$HTTP_URL/fixture-manifest.json")
version_a=$(printf '%s\n' "$manifest" | sed -n 's/.*"versionA"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
version_b=$(printf '%s\n' "$manifest" | sed -n 's/.*"versionB"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)

# Reinstall the global package at B through npm's normal upgrade path without clearing its cache.
run_expect install-a 0 npm install -g "hunkdiff@$version_a" --registry "$REGISTRY_URL"
run_expect version-a 0 hunk --version
assert_contains installed-a "$command_dir/version-a.log" "$version_a"
run_expect upgrade-b 0 npm install -g "hunkdiff@$version_b" --registry "$REGISTRY_URL"
run_expect version-b 0 hunk --version
assert_contains installed-b "$command_dir/version-b.log" "$version_b"
assert_not_contains no-stale-version "$command_dir/version-b.log" "$version_a"
platform_root="$npm_config_prefix/lib/node_modules/hunkdiff/node_modules/hunkdiff-linux-x64"
assert_path_state platform-binary-b executable "$platform_root/bin/hunk"
run_expect platform-manifest-b 0 node -e 'console.log(require(process.argv[1]).version)' "$platform_root/package.json"
assert_contains platform-version-b "$command_dir/platform-manifest-b.log" "$version_b"
run_expect dependency-tree 0 npm ls -g --all --json
assert_tree_has_no_bun_packages no-bun-packages "$npm_config_prefix"
record_observation hunkVersion "$version_b"
record_observation previousHunkVersion "$version_a"
record_observation installSource npm-prebuilt-upgrade
record_observation resolvedExecutable "$platform_root/bin/hunk"
record_observation dependencyTreePath commands/dependency-tree.log
scenario_finish
