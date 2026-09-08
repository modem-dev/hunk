#!/usr/bin/env bash
# shellcheck source=../guest/scenario-lib.sh
# shellcheck disable=SC1091,SC2154
source /tmp/hunk-install-vm/scenario-lib.sh
setup_profile
current=$(curl -fsS "$HTTP_URL/fixture-manifest.json" | sed -n 's/.*"currentVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
run_expect install-online 0 npm install -g "hunkdiff@$current" --registry "$REGISTRY_URL"
# Remove egress only after installation, then prove both the network block and local execution.
ip route del default 2>/dev/null || true
printf '%s\n' offline >"$artifact_dir/network-events.txt"
run_expect_nonzero public-network-blocked curl -fsS --connect-timeout 2 --max-time 3 https://registry.npmjs.org/-/ping
run_expect offline-version 0 hunk --version
assert_contains offline-version-output "$command_dir/offline-version.log" "$current"
run_expect offline-help 0 hunk --help
record_observation hunkVersion "$current"
record_observation installSource npm-prebuilt-offline
record_observation resolvedExecutable "$npm_config_prefix/lib/node_modules/hunkdiff/node_modules/hunkdiff-linux-x64/bin/hunk"
scenario_finish
