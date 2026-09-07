#!/usr/bin/env bash
# shellcheck source=../guest/scenario-lib.sh
# shellcheck disable=SC1091,SC2154
source /tmp/hunk-install-vm/scenario-lib.sh
setup_profile
current=$(curl -fsS "$HTTP_URL/fixture-manifest.json" | sed -n 's/.*"currentVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)

install_git() {
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git
}

run_expect install-git 0 install_git
run_expect install-current 0 npm install -g "hunkdiff@$current" --registry "$REGISTRY_URL"
run_expect git-version 0 git --version

repo="$HOME/repo"
mkdir -p "$repo"
cd "$repo" || exit 1
git init -q
git config user.name "Hunk VM"
git config user.email "hunk-vm@example.invalid"
git config color.ui false
printf 'before\n' >example.txt
git add example.txt
git commit -qm baseline
printf 'after\n' >example.txt
git --no-pager diff --no-color >"$artifact_dir/expected.patch"
git config core.pager "hunk pager"

pager_command=$(git config core.pager)
assert_equals pager-config "hunk pager" "$pager_command"

run_piped_diff() {
  git diff | cat
}

run_packaged_pager() {
  hunk pager <"$artifact_dir/expected.patch"
}

assert_raw_patch() {
  local id=$1 actual=$2
  if cmp -s "$artifact_dir/expected.patch" "$actual"; then
    record_assertion "$id" passed "raw unified patch bytes" "exact match" "output matches git --no-pager diff"
  else
    record_assertion "$id" failed "raw unified patch bytes" "different output" "see ${actual#"$artifact_dir/"}"
  fi
}

assert_no_terminal_controls() {
  local id=$1 actual=$2
  if LC_ALL=C grep -q $'\033' "$actual"; then
    record_assertion "$id" failed "no terminal escapes" "escape found" "see ${actual#"$artifact_dir/"}"
  else
    record_assertion "$id" passed "no terminal escapes" "none" "output contains no escape byte"
  fi
}

run_expect redirected-diff 0 git diff
assert_raw_patch redirected-raw-patch "$command_dir/redirected-diff.log"
assert_no_terminal_controls redirected-no-controls "$command_dir/redirected-diff.log"

run_expect piped-diff 0 run_piped_diff
assert_raw_patch piped-raw-patch "$command_dir/piped-diff.log"
assert_no_terminal_controls piped-no-controls "$command_dir/piped-diff.log"

run_expect packaged-pager-diff 0 run_packaged_pager
assert_raw_patch packaged-pager-raw-patch "$command_dir/packaged-pager-diff.log"
assert_no_terminal_controls packaged-pager-no-controls "$command_dir/packaged-pager-diff.log"

record_observation hunkVersion "$current"
record_observation pagerCommand "$pager_command"
scenario_finish
