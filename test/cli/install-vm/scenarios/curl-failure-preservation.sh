#!/usr/bin/env bash
# shellcheck source=../guest/scenario-lib.sh
# shellcheck disable=SC1091,SC2154
source /tmp/hunk-install-vm/scenario-lib.sh
setup_profile
manifest=$(curl -fsS "$HTTP_URL/fixture-manifest.json")
current=$(printf '%s\n' "$manifest" | sed -n 's/.*"currentVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
versions=$(curl -fsS "$HTTP_URL/curl-versions.json")
bad=$(printf '%s\n' "$versions" | sed -n 's/.*"badChecksum"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
truncated=$(printf '%s\n' "$versions" | sed -n 's/.*"truncated"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
unavailable=$(printf '%s\n' "$versions" | sed -n 's/.*"unavailable"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
curl -fsS "$HTTP_URL/install.sh" -o "$HOME/install.sh"
run_expect seed-install 0 env HOME="$HOME" HUNK_NO_MODIFY_PATH=1 sh "$HOME/install.sh" "$current"
binary="$HOME/.hunk/bin/hunk"
skill="$HOME/.hunk/skills/hunk-review/SKILL.md"
# Hash a known-good install so every failure path proves it leaves active files byte-for-byte intact.
before_binary=$(sha256sum "$binary" | cut -d' ' -f1)
before_skill=$(sha256sum "$skill" | cut -d' ' -f1)

run_expect_nonzero bad-checksum env HOME="$HOME" HUNK_NO_MODIFY_PATH=1 sh "$HOME/install.sh" "$bad"
assert_contains bad-checksum-message "$command_dir/bad-checksum.log" "Checksum verification failed"
assert_equals binary-after-checksum "$before_binary" "$(sha256sum "$binary" | cut -d' ' -f1)"
assert_equals skill-after-checksum "$before_skill" "$(sha256sum "$skill" | cut -d' ' -f1)"

run_expect_nonzero truncated-payload env HOME="$HOME" HUNK_NO_MODIFY_PATH=1 sh "$HOME/install.sh" "$truncated"
assert_equals binary-after-truncation "$before_binary" "$(sha256sum "$binary" | cut -d' ' -f1)"
assert_equals skill-after-truncation "$before_skill" "$(sha256sum "$skill" | cut -d' ' -f1)"

run_expect_nonzero unavailable-asset env HOME="$HOME" HUNK_NO_MODIFY_PATH=1 sh "$HOME/install.sh" "$unavailable"
assert_contains unavailable-message "$command_dir/unavailable-asset.log" "Could not download"
assert_equals binary-after-unavailable "$before_binary" "$(sha256sum "$binary" | cut -d' ' -f1)"
assert_equals skill-after-unavailable "$before_skill" "$(sha256sum "$skill" | cut -d' ' -f1)"
assert_path_state no-partial-binary missing "$HOME/.hunk/bin/hunk.new"
run_expect preserved-version 0 "$binary" --version
assert_contains preserved-version-output "$command_dir/preserved-version.log" "$current"
record_observation hunkVersion "$current"
record_observation installSource curl-preserved
record_observation resolvedExecutable "$binary"
scenario_finish
