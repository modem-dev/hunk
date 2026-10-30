#!/usr/bin/env bash
# shellcheck source=../guest/scenario-lib.sh
# shellcheck disable=SC1091,SC2154
source /tmp/hunk-install-vm/scenario-lib.sh
setup_profile
install_pnpm
pnpm config set registry https://registry.npmjs.org/
hunkdiff_version=${HISTORICAL_HUNKDIFF_VERSION:?HISTORICAL_HUNKDIFF_VERSION is required}
bun_version=${HISTORICAL_BUN_VERSION:?HISTORICAL_BUN_VERSION is required}

# Add Bun explicitly so pnpm resolves Hunk's compatible transitive range to the historical release.
run_expect historical-install 0 pnpm add -g "hunkdiff@$hunkdiff_version" "bun@$bun_version"
bun_manifest=$(find "$HOME/pnpm/store" -path "*/bun/$bun_version/*/node_modules/bun/package.json" -type f -print -quit 2>/dev/null)
run_expect historical-bun-version 0 node -e 'console.log(require(process.argv[1]).version)' "$bun_manifest"
assert_contains historical-bun-pinned "$command_dir/historical-bun-version.log" "$bun_version"
# Bun's postinstall moves this executable out of the shared projection; its absence is the oracle.
find "$HOME/pnpm/store" \( -path '*/@oven/bun-linux-x64/*/bin' -o -path '*/node_modules/bun' \) -print >"$artifact_dir/store-projection.txt" 2>/dev/null
platform_bin_dir=$(find "$HOME/pnpm/store" -path '*/@oven/bun-linux-x64/*/bin' -type d -print -quit 2>/dev/null)
if [[ -n $platform_bin_dir && ! -e $platform_bin_dir/bun ]]; then
  record_assertion projection-mutated passed "platform executable missing after Bun postinstall" missing "$platform_bin_dir/bun"
else
  record_assertion projection-mutated failed "platform executable missing after Bun postinstall" present "${platform_bin_dir:-not found}"
fi

update_log="$command_dir/historical-update.log"
run_capture historical-update pnpm update -g hunkdiff
update_status=$last_command_status
if grep -Fq 'Failed to find package "@oven/bun-linux-x64"' "$update_log"; then
  record_assertion missing-package-diagnostic passed "historical missing-package error" present "issue #866 diagnostic observed"
else
  record_assertion missing-package-diagnostic failed "historical missing-package error" missing "see commands/historical-update.log"
fi
run_expect dependency-tree 0 pnpm list -g hunkdiff --depth Infinity --json
record_observation hunkVersion "$hunkdiff_version"
record_observation installSource historical-pnpm-live
record_observation bunVersion "$bun_version"
record_observation dependencyTreePath commands/dependency-tree.log
record_observation storeProjectionPath store-projection.txt
# Linux may download a replacement and recover; preserve that distinction from macOS's final failure.
if [[ $update_status -eq 0 ]]; then
  printf 'linuxRecovery=true\nupdateExitCode=0\n' >"$artifact_dir/linux-recovery.txt"
  record_assertion linux-outcome passed "recovery or failure reported separately" recovery "Linux installer recovered"
else
  printf 'linuxRecovery=false\nupdateExitCode=%s\n' "$update_status" >"$artifact_dir/linux-recovery.txt"
  record_assertion linux-outcome passed "recovery or failure reported separately" "exit $update_status" "historical failure observed"
fi
scenario_finish
