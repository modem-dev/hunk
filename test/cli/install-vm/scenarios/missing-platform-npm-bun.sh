#!/usr/bin/env bash
# shellcheck source=../guest/scenario-lib.sh
# shellcheck disable=SC1091,SC2154
source /tmp/hunk-install-vm/scenario-lib.sh
setup_profile
version_b=$(curl -fsS "$HTTP_URL/fixture-manifest.json" | sed -n 's/.*"versionB"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)

# Install Bun as an npm package, which is a separate fallback path from a `bun` command on PATH.
run_expect install-npm-bun 0 npm install -g "bun@1.3.14" --registry "$REGISTRY_URL"
run_expect install-without-platform 0 npm install -g --omit=optional "hunkdiff@$version_b" --registry "$REGISTRY_URL"
remove_platform_package
run_expect fallback-version 0 node "$npm_config_prefix/lib/node_modules/hunkdiff/bin/hunk.cjs" --version
assert_contains npm-bun-fallback "$command_dir/fallback-version.log" "fallback-$version_b"
assert_path_state no-platform missing "$npm_config_prefix/lib/node_modules/hunkdiff/node_modules/hunkdiff-linux-x64"
bun_executable="$npm_config_prefix/lib/node_modules/bun/bin/bun.exe"
assert_path_state npm-bun executable "$bun_executable"
record_observation hunkVersion "fallback-$version_b"
record_observation installSource npm-bun-fallback
record_observation resolvedExecutable "$bun_executable"
scenario_finish
