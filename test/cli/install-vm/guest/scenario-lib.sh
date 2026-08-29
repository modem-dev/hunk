#!/usr/bin/env bash
set -u
umask 077

artifact_dir=/var/tmp/hunk-install-vm
command_dir="$artifact_dir/commands"
mkdir -p "$command_dir"
: >"$artifact_dir/assertions.tsv"
: >"$artifact_dir/commands.tsv"
: >"$artifact_dir/observations.tsv"
scenario_failures=0
last_command_status=0

# The host parses these TSV files strictly, so keep guest-controlled output on one field-safe line.
sanitize_field() {
  printf '%s' "$1" | tr '\t\r\n' '   '
}

record_assertion() {
  local id=$1 status=$2 expected=$3 actual=$4 message=$5
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$(sanitize_field "$id")" \
    "$(sanitize_field "$status")" \
    "$(sanitize_field "$expected")" \
    "$(sanitize_field "$actual")" \
    "$(sanitize_field "$message")" >>"$artifact_dir/assertions.tsv"
  [[ $status == passed ]] || scenario_failures=1
}

record_command() {
  local id=$1 status=$2 expectation=$3 actual=$4 log_path=$5
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$(sanitize_field "$id")" \
    "$(sanitize_field "$status")" \
    "$(sanitize_field "$expectation")" \
    "$(sanitize_field "$actual")" \
    "$(sanitize_field "$log_path")" >>"$artifact_dir/commands.tsv"
}

record_observation() {
  local key=$1 value=$2
  printf '%s\t%s\n' "$(sanitize_field "$key")" "$(sanitize_field "$value")" \
    >>"$artifact_dir/observations.tsv"
}

# Record mismatches without aborting so one scenario returns all useful assertion evidence.
run_expect() {
  local id=$1 expected=$2
  shift 2
  local log="$command_dir/$id.log" actual
  "$@" >"$log" 2>&1
  actual=$?
  if [[ $actual == "$expected" ]]; then
    record_command "$id" passed "exit $expected" "$actual" "commands/$id.log"
    record_assertion "$id" passed "exit $expected" "exit $actual" "command matched expected exit"
  else
    record_command "$id" failed "exit $expected" "$actual" "commands/$id.log"
    record_assertion "$id" failed "exit $expected" "exit $actual" "see commands/$id.log"
  fi
  return 0
}

run_expect_nonzero() {
  local id=$1
  shift
  local log="$command_dir/$id.log" actual
  "$@" >"$log" 2>&1
  actual=$?
  if [[ $actual -ne 0 ]]; then
    record_command "$id" passed "nonzero exit" "$actual" "commands/$id.log"
    record_assertion "$id" passed "nonzero exit" "exit $actual" "expected failure occurred"
  else
    record_command "$id" failed "nonzero exit" 0 "commands/$id.log"
    record_assertion "$id" failed "nonzero exit" "exit 0" "unexpected success; see commands/$id.log"
  fi
  return 0
}

run_capture() {
  local id=$1
  shift
  local log="$command_dir/$id.log"
  "$@" >"$log" 2>&1
  last_command_status=$?
  record_command "$id" passed "observed exit" "$last_command_status" "commands/$id.log"
  return 0
}

assert_contains() {
  local id=$1 file=$2 marker=$3
  if grep -Fq -- "$marker" "$file"; then
    record_assertion "$id" passed "contains $marker" present "marker found"
  else
    record_assertion "$id" failed "contains $marker" missing "see ${file#"$artifact_dir"/}"
  fi
}

assert_not_contains() {
  local id=$1 file=$2 marker=$3
  if grep -Fq -- "$marker" "$file"; then
    record_assertion "$id" failed "does not contain $marker" present "unexpected marker"
  else
    record_assertion "$id" passed "does not contain $marker" absent "marker absent"
  fi
}

assert_equals() {
  local id=$1 expected=$2 actual=$3
  if [[ $actual == "$expected" ]]; then
    record_assertion "$id" passed "$expected" "$actual" "values match"
  else
    record_assertion "$id" failed "$expected" "$actual" "values differ"
  fi
}

assert_path_state() {
  local id=$1 expected=$2 target=$3
  local actual=missing
  [[ -f $target ]] && actual="file"
  [[ -d $target ]] && actual="directory"
  [[ -x $target ]] && actual="executable"
  if [[ $actual == "$expected" ]]; then
    record_assertion "$id" passed "$expected" "$actual" "$target"
  else
    record_assertion "$id" failed "$expected" "$actual" "$target"
  fi
}

assert_tree_has_no_bun_packages() {
  local id=$1 root=$2 found
  found=$(find "$root" -type d \( -path '*/node_modules/bun' -o -path '*/node_modules/@oven/bun-*' \) -print -quit 2>/dev/null)
  if [[ -z $found ]]; then
    record_assertion "$id" passed "no bun or @oven/bun-* package" absent "$root"
  else
    record_assertion "$id" failed "no bun or @oven/bun-* package" "$found" "unexpected package"
  fi
}

# Build an isolated user/package-manager environment and deliberately hide Node for minimal profiles.
setup_profile() {
  export HOME=/root/scenario
  export XDG_CONFIG_HOME="$HOME/.config"
  export XDG_CACHE_HOME="$HOME/.cache"
  export npm_config_prefix="$HOME/npm"
  export npm_config_cache="$HOME/npm-cache"
  mkdir -p "$HOME" "$npm_config_prefix" "$npm_config_cache"
  if [[ ${INSTALL_VM_PROFILE:-node} == node ]]; then
    export PATH="/opt/node/bin:$npm_config_prefix/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  else
    export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  fi
  {
    uname -a
    printf 'PATH=%s\n' "$PATH"
    command -v node >/dev/null 2>&1 && node --version || printf 'node=absent\n'
    command -v bun >/dev/null 2>&1 && bun --version || printf 'bun=absent\n'
  } >"$artifact_dir/environment.txt" 2>&1
  if command -v node >/dev/null 2>&1; then
    record_observation nodeVersion "$(node --version)"
    record_observation npmVersion "$(npm --version)"
  fi
}

remove_platform_package() {
  rm -rf \
    "$npm_config_prefix/lib/node_modules/hunkdiff/node_modules/hunkdiff-linux-x64" \
    "$npm_config_prefix/lib/node_modules/hunkdiff-linux-x64"
}

# Recreate the shared global virtual-store configuration involved in issue #866.
install_pnpm() {
  local version=${PNPM_VERSION:?PNPM_VERSION is required}
  npm install -g "pnpm@$version" --registry "$REGISTRY_URL" >"$command_dir/install-pnpm.log" 2>&1
  export PNPM_HOME="$HOME/pnpm/bin"
  mkdir -p "$PNPM_HOME"
  export PATH="$PNPM_HOME:$PATH"
  pnpm config set globalBinDir "$PNPM_HOME"
  pnpm config set globalDir "$HOME/pnpm/global"
  pnpm config set storeDir "$HOME/pnpm/store"
  pnpm config set enableGlobalVirtualStore true
  pnpm config set dangerouslyAllowAllBuilds true
  pnpm config set minimumReleaseAge 0
  pnpm config set registry "$REGISTRY_URL"
  record_observation pnpmVersion "$(pnpm --version)"
}

scenario_finish() {
  if [[ $scenario_failures == 0 ]]; then
    exit 0
  fi
  exit 1
}
