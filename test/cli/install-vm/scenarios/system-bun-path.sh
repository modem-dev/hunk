#!/usr/bin/env bash
# shellcheck source=../guest/scenario-lib.sh
# shellcheck disable=SC1091,SC2154
source /tmp/hunk-install-vm/scenario-lib.sh
setup_profile
manifest=$(curl -fsS "$HTTP_URL/fixture-manifest.json")
version_b=$(printf '%s\n' "$manifest" | sed -n 's/.*"versionB"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
run_expect install-hunk 0 npm install -g "hunkdiff@$version_b" --registry "$REGISTRY_URL"

mkdir -p "$HOME/system-bin"
marker="$artifact_dir/system-bun-invoked"
# Swap marker-writing Bun stubs across versions to verify the platform binary always wins.
write_stub() {
  local version=$1
  cat >"$HOME/system-bin/bun" <<STUB
#!/bin/sh
printf '%s\\n' invoked >>'$marker'
printf '%s\\n' '$version'
STUB
  chmod 0755 "$HOME/system-bin/bun"
}
export PATH="$HOME/system-bin:$PATH"
write_stub 1.0.0
run_expect old-path-bun 0 hunk --version
assert_contains old-platform-wins "$command_dir/old-path-bun.log" "$version_b"
write_stub 1.3.14
run_expect current-path-bun 0 hunk --version
assert_contains current-platform-wins "$command_dir/current-path-bun.log" "$version_b"
record_observation hunkVersion "$version_b"
record_observation installSource npm-prebuilt
record_observation resolvedExecutable "$npm_config_prefix/lib/node_modules/hunkdiff/node_modules/hunkdiff-linux-x64/bin/hunk"
if [[ -e $marker ]]; then
  record_assertion path-bun-not-spawned failed absent present "standalone Bun was invoked"
else
  record_assertion path-bun-not-spawned passed absent absent "platform package stayed primary"
fi
scenario_finish
