#!/usr/bin/env bash
# shellcheck source=../guest/scenario-lib.sh
# shellcheck disable=SC1091,SC2154
source /tmp/hunk-install-vm/scenario-lib.sh
setup_profile
current=$(curl -fsS "$HTTP_URL/fixture-manifest.json" | sed -n 's/.*"currentVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
curl -fsS "$HTTP_URL/install.sh" -o "$HOME/install.sh"

# The minimal profile hides the Node embedded in the base image to model a clean user machine.
if command -v node >/dev/null 2>&1 || command -v bun >/dev/null 2>&1; then
  record_assertion minimal-profile failed "no Node or Bun" present "unexpected runtime on minimal PATH"
else
  record_assertion minimal-profile passed "no Node or Bun" absent "minimal PATH has no language runtime"
fi
run_expect curl-install 0 env HOME="$HOME" HUNK_NO_MODIFY_PATH=1 sh "$HOME/install.sh" "$current"
assert_contains checksum-verified "$command_dir/curl-install.log" "Verifying checksum"
assert_path_state installed-binary executable "$HOME/.hunk/bin/hunk"
assert_path_state installed-review-skill file "$HOME/.hunk/skills/hunk-review/SKILL.md"
assert_path_state installed-extension-skill file "$HOME/.hunk/skills/hunk-extensions/SKILL.md"
run_expect curl-version 0 "$HOME/.hunk/bin/hunk" --version
assert_contains curl-version-output "$command_dir/curl-version.log" "$current"
run_expect curl-help 0 "$HOME/.hunk/bin/hunk" --help
assert_contains curl-help-output "$command_dir/curl-help.log" "Usage: hunk"
run_expect review-skill-path 0 "$HOME/.hunk/bin/hunk" skill path hunk-review
assert_contains review-skill-path-output "$command_dir/review-skill-path.log" "$HOME/.hunk/skills/hunk-review/SKILL.md"
run_expect extension-skill-path 0 "$HOME/.hunk/bin/hunk" skill path hunk-extensions
assert_contains extension-skill-path-output "$command_dir/extension-skill-path.log" "$HOME/.hunk/skills/hunk-extensions/SKILL.md"
record_observation hunkVersion "$current"
record_observation installSource curl
record_observation resolvedExecutable "$HOME/.hunk/bin/hunk"
scenario_finish
