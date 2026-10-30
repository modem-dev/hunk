#!/usr/bin/env bash
# shellcheck source=../guest/scenario-lib.sh
# shellcheck disable=SC1091,SC2154
source /tmp/hunk-install-vm/scenario-lib.sh
setup_profile
version_b=$(curl -fsS "$HTTP_URL/fixture-manifest.json" | sed -n 's/.*"versionB"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
run_expect install-without-platform 0 npm install -g --omit=optional "hunkdiff@$version_b" --registry "$REGISTRY_URL"
remove_platform_package

mkdir -p "$HOME/system-bin"
marker="$artifact_dir/system-bun-invoked"
# A marker-writing stub proves the launcher does not confuse PATH Bun with its npm fallback.
cat >"$HOME/system-bin/bun" <<STUB
#!/bin/sh
printf '%s\\n' invoked >>'$marker'
exit 42
STUB
chmod 0755 "$HOME/system-bin/bun"
export PATH="$HOME/system-bin:$PATH"
run_expect missing-platform 1 node "$npm_config_prefix/lib/node_modules/hunkdiff/bin/hunk.cjs" --version
assert_contains repair-package "$command_dir/missing-platform.log" 'manually installing "hunkdiff-linux-x64"'
record_observation installSource missing-platform-system-bun
record_observation hunkVersion unavailable
if [[ -e $marker ]]; then
  record_assertion path-bun-not-fallback failed absent present "PATH Bun was invoked"
else
  record_assertion path-bun-not-fallback passed absent absent "Node-resolvable Bun remains distinct"
fi
scenario_finish
