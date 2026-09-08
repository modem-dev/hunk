#!/usr/bin/env bash
# shellcheck source=../guest/scenario-lib.sh
# shellcheck disable=SC1091,SC2154
source /tmp/hunk-install-vm/scenario-lib.sh
setup_profile
manifest=$(curl -fsS "$HTTP_URL/fixture-manifest.json")
version_a=$(printf '%s\n' "$manifest" | sed -n 's/.*"versionA"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
version_b=$(printf '%s\n' "$manifest" | sed -n 's/.*"versionB"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
curl -fsS "$HTTP_URL/install.sh" -o "$HOME/install.sh"

# Install A first, then exercise the production installer's successful replacement path with B.
run_expect install-a 0 env HOME="$HOME" HUNK_NO_MODIFY_PATH=1 sh "$HOME/install.sh" "$version_a"
binary="$HOME/.hunk/bin/hunk"
run_expect version-a 0 "$binary" --version
assert_contains installed-a "$command_dir/version-a.log" "$version_a"
assert_contains checksum-a "$command_dir/install-a.log" "Verifying checksum"
before_binary=$(sha256sum "$binary" | cut -d' ' -f1)

run_expect upgrade-b 0 env HOME="$HOME" HUNK_NO_MODIFY_PATH=1 sh "$HOME/install.sh" "$version_b"
run_expect version-b 0 "$binary" --version
assert_contains installed-b "$command_dir/version-b.log" "$version_b"
assert_not_contains no-stale-version "$command_dir/version-b.log" "$version_a"
assert_contains checksum-b "$command_dir/upgrade-b.log" "Verifying checksum"
after_binary=$(sha256sum "$binary" | cut -d' ' -f1)
if [[ $after_binary != "$before_binary" ]]; then
  record_assertion binary-replaced passed "different binary digest" changed "curl upgrade activated version B"
else
  record_assertion binary-replaced failed "different binary digest" unchanged "curl upgrade retained version A bytes"
fi
assert_path_state upgraded-binary executable "$binary"
assert_path_state upgraded-review-skill file "$HOME/.hunk/skills/hunk-review/SKILL.md"
assert_path_state upgraded-extension-skill file "$HOME/.hunk/skills/hunk-extensions/SKILL.md"
assert_contains skills-version-b "$HOME/.hunk/skills/.fixture-version" "$version_b"
assert_contains metadata-version-b "$HOME/.hunk/metadata.json" "\"fixtureVersion\": \"$version_b\""
assert_path_state no-partial-binary missing "$HOME/.hunk/bin/hunk.new"
assert_path_state no-staged-skills missing "$HOME/.hunk/skills.new"
assert_path_state no-retired-skills missing "$HOME/.hunk/skills.old"
record_observation hunkVersion "$version_b"
record_observation previousHunkVersion "$version_a"
record_observation installSource curl-upgrade
record_observation resolvedExecutable "$binary"
scenario_finish
