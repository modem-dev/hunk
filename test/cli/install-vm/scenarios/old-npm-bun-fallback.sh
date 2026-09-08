#!/usr/bin/env bash
# shellcheck source=../guest/scenario-lib.sh
# shellcheck disable=SC1091,SC2154
source /tmp/hunk-install-vm/scenario-lib.sh
setup_profile
version_b=$(curl -fsS "$HTTP_URL/fixture-manifest.json" | sed -n 's/.*"versionB"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)

run_expect install-old-npm-bun 0 npm install -g "bun@1.1.0" --registry "$REGISTRY_URL"
run_expect install-without-platform 0 npm install -g --omit=optional "hunkdiff@$version_b" --registry "$REGISTRY_URL"
remove_platform_package
old_log="$command_dir/old-fallback-version.log"
run_capture old-fallback-version node "$npm_config_prefix/lib/node_modules/hunkdiff/bin/hunk.cjs" --version
old_status=$last_command_status
# Accept and describe either known outcome without turning this observation into a support policy.
if [[ $old_status -eq 0 ]] && grep -Fq "fallback-$version_b" "$old_log"; then
  record_assertion old-npm-bun-observation passed "best-effort outcome recorded" fallback "older npm Bun executed the fallback"
  printf 'fallbackAvailable=true\nexitCode=0\n' >"$artifact_dir/fallback-policy.txt"
  record_observation hunkVersion "fallback-$version_b"
  record_observation resolvedExecutable "$npm_config_prefix/lib/node_modules/bun/bin/bun.exe"
elif [[ $old_status -ne 0 ]] && grep -Fq 'manually installing "hunkdiff-linux-x64"' "$old_log"; then
  record_assertion old-npm-bun-observation passed "best-effort outcome recorded" unavailable "older npm Bun did not expose the current resolvable fallback path"
  printf 'fallbackAvailable=false\nexitCode=%s\n' "$old_status" >"$artifact_dir/fallback-policy.txt"
  record_observation hunkVersion unavailable
else
  record_assertion old-npm-bun-observation failed "recognized fallback or repair outcome" "exit $old_status" "see commands/old-fallback-version.log"
fi
printf '%s\n' 'This observation does not declare a minimum supported Bun version.' >>"$artifact_dir/fallback-policy.txt"
record_observation installSource npm-bun-fallback-best-effort
scenario_finish
