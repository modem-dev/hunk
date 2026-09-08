#!/usr/bin/env bash
# shellcheck source=../guest/scenario-lib.sh
# shellcheck disable=SC1091,SC2154
source /tmp/hunk-install-vm/scenario-lib.sh
setup_profile
version_b=$(curl -fsS "$HTTP_URL/fixture-manifest.json" | sed -n 's/.*"versionB"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)

# Omit optional packages at install time, then remove either possible layout defensively.
run_expect install-without-platform 0 npm install -g --omit=optional "hunkdiff@$version_b" --registry "$REGISTRY_URL"
remove_platform_package
run_expect missing-platform 1 node "$npm_config_prefix/lib/node_modules/hunkdiff/bin/hunk.cjs" --version
assert_contains repair-package "$command_dir/missing-platform.log" 'manually installing "hunkdiff-linux-x64"'
assert_tree_has_no_bun_packages no-bun-packages "$npm_config_prefix"
record_observation installSource missing-platform
record_observation hunkVersion unavailable
scenario_finish
