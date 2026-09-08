#!/usr/bin/env bash
# This scenario intentionally relies on Linux /proc and GNU timeout, date, readlink, and sha256sum.
# shellcheck source=../guest/scenario-lib.sh
# shellcheck disable=SC1091,SC2154
source /tmp/hunk-install-vm/scenario-lib.sh
setup_profile

old_wrapper=
old_wrapper_token=
old_client=
old_client_token=
new_first_wrapper=
new_first_wrapper_token=
new_first_client=
new_first_client_token=
new_second_wrapper=
new_second_wrapper_token=
new_second_client=
new_second_client_token=
new_second_stopped=0
fd3_open=0
fd4_open=0
fd5_open=0

wait_for() {
  local timeout_seconds=$1
  shift
  local deadline=$((SECONDS + timeout_seconds))
  while ((SECONDS < deadline)); do
    "$@" && return 0
    sleep 0.5
  done
  return 1
}

process_identity_snapshot() {
  local pid=$1
  [[ -r /proc/$pid/stat ]] || return 1
  # One read returns Linux stat fields 3 (state) and 22 (starttime).
  awk '{line=$0; sub(/^[^)]*\) /,"",line); split(line,fields," "); print fields[1], fields[20]}' "/proc/$pid/stat"
}

process_start_token() {
  local state token
  read -r state token < <(process_identity_snapshot "$1") || return 1
  [[ $state != Z ]] || return 1
  printf '%s' "$token"
}

process_identity_is() {
  local pid=$1 expected_token=$2 state token
  [[ -n $pid && -n $expected_token ]] || return 1
  read -r state token < <(process_identity_snapshot "$pid") || return 1
  [[ $state != Z && $token == "$expected_token" ]]
}

process_identity_state_is() {
  local pid=$1 expected_token=$2 expected_state=$3 state token
  read -r state token < <(process_identity_snapshot "$pid") || return 1
  [[ $token == "$expected_token" && $state == "$expected_state" ]]
}

process_identity_not_stopped() {
  local pid=$1 expected_token=$2 state token
  read -r state token < <(process_identity_snapshot "$pid") || return 1
  [[ $token == "$expected_token" && $state != T && $state != t && $state != Z ]]
}

process_identity_gone() {
  ! process_identity_is "$1" "$2"
}

pidfd_signal_owned_identity() {
  local pid=$1 token=$2 signal_name=$3
  python3 - "$pid" "$token" "$signal_name" <<'PY'
import os, signal, sys
pid, expected, signal_name = int(sys.argv[1]), sys.argv[2], sys.argv[3]
def identity():
    with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as stream:
        fields = stream.read().rsplit(") ", 1)[1].split()
    return fields[0], fields[19]
state, token = identity()
if state == "Z" or token != expected:
    raise SystemExit(1)
fd = os.pidfd_open(pid, 0)
try:
    state, token = identity()
    if state == "Z" or token != expected:
        raise SystemExit(1)
    signal.pidfd_send_signal(fd, getattr(signal, f"SIG{signal_name}"))
finally:
    os.close(fd)
PY
}

terminate_owned_identity() {
  local pid=$1 token=$2
  process_identity_is "$pid" "$token" || return 0
  pidfd_signal_owned_identity "$pid" "$token" TERM 2>/dev/null || return 1
  if ! wait_for 3 process_identity_gone "$pid" "$token"; then
    pidfd_signal_owned_identity "$pid" "$token" KILL 2>/dev/null || return 1
    wait_for 3 process_identity_gone "$pid" "$token" || return 1
  fi
}

cleanup_upgrade() {
  local status=$?
  trap - EXIT
  set +e
  if [[ $new_second_stopped == 1 ]] && process_identity_is "$new_second_client" "$new_second_client_token"; then
    pidfd_signal_owned_identity "$new_second_client" "$new_second_client_token" CONT 2>/dev/null || true
    new_second_stopped=0
  fi
  [[ $fd3_open == 1 ]] && printf 'q' >&3
  [[ $fd4_open == 1 ]] && printf 'q' >&4
  [[ $fd5_open == 1 ]] && printf 'q' >&5
  sleep 0.5
  local cleanup_failed=0
  terminate_owned_identity "$old_client" "$old_client_token" || cleanup_failed=1
  terminate_owned_identity "$new_first_client" "$new_first_client_token" || cleanup_failed=1
  terminate_owned_identity "$new_second_client" "$new_second_client_token" || cleanup_failed=1
  terminate_owned_identity "$old_wrapper" "$old_wrapper_token" || cleanup_failed=1
  terminate_owned_identity "$new_first_wrapper" "$new_first_wrapper_token" || cleanup_failed=1
  terminate_owned_identity "$new_second_wrapper" "$new_second_wrapper_token" || cleanup_failed=1
  if [[ -n $old_wrapper ]] && process_identity_gone "$old_wrapper" "$old_wrapper_token"; then wait "$old_wrapper" 2>/dev/null || true; fi
  if [[ -n $new_first_wrapper ]] && process_identity_gone "$new_first_wrapper" "$new_first_wrapper_token"; then wait "$new_first_wrapper" 2>/dev/null || true; fi
  if [[ -n $new_second_wrapper ]] && process_identity_gone "$new_second_wrapper" "$new_second_wrapper_token"; then wait "$new_second_wrapper" 2>/dev/null || true; fi
  if [[ $cleanup_failed == 0 ]]; then
    record_assertion test-process-cleanup passed "all test-owned identities gone" gone "bounded pidfd cleanup completed"
  else
    record_assertion test-process-cleanup failed "all test-owned identities gone" alive "bounded cleanup left a test-owned identity"
    status=1
  fi
  [[ $fd3_open == 1 ]] && exec 3>&-
  [[ $fd4_open == 1 ]] && exec 4>&-
  [[ $fd5_open == 1 ]] && exec 5>&-
  exit "$status"
}
trap cleanup_upgrade EXIT

metadata_pid() {
  timeout 5 node -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(!Number.isInteger(value.pid)||value.pid<1) process.exit(1); process.stdout.write(String(value.pid));' "$1"
}

health_is_minimal() {
  timeout 5 node -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const keys=Object.keys(value); process.exit(keys.length===1&&keys[0]==="ok"&&value.ok===true?0:1);' "$1"
}

session_pids_are() {
  local binary=$1 expected_csv=$2 output=$3
  timeout 8 "$binary" session list --json >"$output" 2>/dev/null || return 1
  timeout 5 node -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const actual=Array.isArray(value.sessions)?value.sessions.map((session)=>session.pid).sort((a,b)=>a-b):[]; const expected=process.argv[2].split(",").filter(Boolean).map(Number).sort((a,b)=>a-b); process.exit(JSON.stringify(actual)===JSON.stringify(expected)?0:1);' "$output" "$expected_csv"
}

wrapper_alive() {
  process_identity_is "$1" "$2"
}

find_descendant_executable() {
  local root=$1 expected_binary=$2 current child executable
  local expected_executable
  expected_executable=$(readlink -f "$expected_binary") || return 1
  local -a queue=("$root")
  while ((${#queue[@]} > 0)); do
    current=${queue[0]}
    queue=("${queue[@]:1}")
    [[ -r /proc/$current/task/$current/children ]] || continue
    for child in $(<"/proc/$current/task/$current/children"); do
      queue+=("$child")
      executable=$(readlink -f "/proc/$child/exe" 2>/dev/null || true)
      if [[ $executable == "$expected_executable" ]]; then
        printf '%s' "$child"
        return 0
      fi
    done
  done
  return 1
}

capture_client_identity() {
  local wrapper=$1 binary=$2 pid_variable=$3 token_variable=$4 pid token
  pid=$(find_descendant_executable "$wrapper" "$binary") || return 1
  token=$(process_start_token "$pid") || return 1
  printf -v "$pid_variable" '%s' "$pid"
  printf -v "$token_variable" '%s' "$token"
}

start_tui() {
  local binary=$1 input_fd=$2 transcript=$3 warning_log=$4 result_variable=$5
  local command wrapper_pid
  printf -v command 'env HUNK_DISABLE_UPDATE_NOTICE=1 %q --no-extensions patch %q 2>>%q' \
    "$binary" "$patch_file" "$warning_log"
  script --quiet --return --flush --command "$command" "$transcript" <&"$input_fd" >/dev/null 2>&1 &
  wrapper_pid=$!
  printf -v "$result_variable" '%s' "$wrapper_pid"
}

successor_metadata_ready() {
  local metadata_file=$1 old_pid=$2 old_token=$3 candidate_pid candidate_token
  [[ -f $metadata_file ]] || return 1
  candidate_pid=$(metadata_pid "$metadata_file") || return 1
  candidate_token=$(process_start_token "$candidate_pid" 2>/dev/null) || return 1
  [[ $candidate_pid != "$old_pid" || $candidate_token != "$old_token" ]] || return 1
  curl --max-time 3 -fsS "http://127.0.0.1:$HUNK_MCP_PORT/health" >/dev/null
}

for tool in script sha256sum timeout node readlink python3; do
  command -v "$tool" >/dev/null 2>&1 || {
    record_assertion linux-tooling failed present "$tool missing" "authenticated daemon upgrade requires Linux/GNU tooling"
    scenario_finish
  }
done
[[ -r /proc/self/stat ]] || {
  record_assertion linux-proc failed present missing "authenticated daemon upgrade requires Linux /proc"
  scenario_finish
}

manifest_file="$artifact_dir/daemon-fixture-manifest.json"
timeout 10 curl --max-time 8 -fsS "$HTTP_URL/fixture-manifest.json" >"$manifest_file"
daemon_version_a=$(timeout 5 node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).daemonUpgrade.versionA' "$manifest_file")
daemon_version_b=$(timeout 5 node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).daemonUpgrade.versionB' "$manifest_file")
daemon_revision_a=$(timeout 5 node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).daemonUpgrade.revisionA' "$manifest_file")
daemon_revision_b=$(timeout 5 node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).daemonUpgrade.revisionB' "$manifest_file")
daemon_binary_sha256_a=$(timeout 5 node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).daemonUpgrade.binarySha256A' "$manifest_file")
daemon_binary_sha256_b=$(timeout 5 node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).daemonUpgrade.binarySha256B' "$manifest_file")
daemon_build_input_identity=$(timeout 5 node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).daemonUpgradeBuildInputIdentity' "$manifest_file")
record_observation daemonPackageVersionA "$daemon_version_a"
record_observation daemonPackageVersionB "$daemon_version_b"
record_observation daemonRevisionA "$daemon_revision_a"
record_observation daemonRevisionB "$daemon_revision_b"
record_observation daemonUpgradeBuildInputIdentity "$daemon_build_input_identity"
record_observation fixtureManifestPath daemon-fixture-manifest.json

export XDG_RUNTIME_DIR="$HOME/runtime"
export HUNK_MCP_HOST=127.0.0.1
export HUNK_MCP_PORT=48761
export HUNK_DISABLE_UPDATE_NOTICE=1
unset HUNK_MCP_DISABLE
mkdir -p "$XDG_RUNTIME_DIR"
chmod 0700 "$XDG_RUNTIME_DIR"

cat >"$HOME/change.patch" <<'PATCH'
diff --git a/example.ts b/example.ts
index 3f52c4e..33d4f84 100644
--- a/example.ts
+++ b/example.ts
@@ -1 +1 @@
-export const answer = 41;
+export const answer = 42;
PATCH
patch_file="$HOME/change.patch"

run_expect install-daemon-a 0 timeout 240 npm install -g "hunkdiff@$daemon_version_a" --registry "$REGISTRY_URL"
installed_binary="$npm_config_prefix/lib/node_modules/hunkdiff/node_modules/hunkdiff-linux-x64/bin/hunk"
old_binary="$HOME/hunk-daemon-a"
cp "$installed_binary" "$old_binary"
chmod 0755 "$old_binary"
run_expect version-daemon-a 0 timeout 10 "$old_binary" --version
assert_contains version-a-matches "$command_dir/version-daemon-a.log" "$daemon_version_a"

mkfifo "$HOME/old-input" "$HOME/new-first-input" "$HOME/new-second-input"
exec 3<>"$HOME/old-input"
fd3_open=1
exec 4<>"$HOME/new-first-input"
fd4_open=1
exec 5<>"$HOME/new-second-input"
fd5_open=1
old_transcript="$artifact_dir/old-transcript.log"
new_first_transcript="$artifact_dir/new-first-transcript.log"
new_second_transcript="$artifact_dir/new-second-transcript.log"
old_warning="$artifact_dir/old-warning.log"
new_first_warning="$artifact_dir/new-first-warning.log"
new_second_warning="$artifact_dir/new-second-warning.log"
start_tui "$old_binary" 3 "$old_transcript" "$old_warning" old_wrapper
old_wrapper_token=$(process_start_token "$old_wrapper")
record_command start-old-tui passed "background PTY remains live" 0 "old-transcript.log"
if wait_for 20 capture_client_identity "$old_wrapper" "$old_binary" old_client old_client_token; then
  record_observation oldWrapperPid "$old_wrapper"
  record_observation oldWrapperStartToken "$old_wrapper_token"
  record_observation oldClientPid "$old_client"
  record_observation oldClientStartToken "$old_client_token"
else
  record_assertion old-client-identity failed "owned Hunk descendant" missing "could not identify old TUI process"
fi

old_list="$artifact_dir/old-session-list.json"
if wait_for 20 session_pids_are "$old_binary" "$old_client" "$old_list"; then
  record_assertion old-producer-registered passed "one authenticated A client PID" present "old TUI registered"
else
  record_assertion old-producer-registered failed "one authenticated A client PID" missing "see old transcript"
fi
run_expect old-session-list 0 timeout 10 "$old_binary" session list --json
cp "$command_dir/old-session-list.log" "$old_list"

metadata="$XDG_RUNTIME_DIR/hunk-mcp/daemon-127-0-0-1-$HUNK_MCP_PORT.json"
if ! wait_for 10 test -f "$metadata"; then
  record_assertion old-metadata failed present missing "scenario-owned launch metadata was not published"
  scenario_finish
fi
cp "$metadata" "$artifact_dir/old-metadata.json"
old_daemon_pid=$(metadata_pid "$metadata")
old_start_token=$(process_start_token "$old_daemon_pid")
old_executable_location=$(readlink "/proc/$old_daemon_pid/exe")
old_executable_digest=$(timeout 10 sha256sum "/proc/$old_daemon_pid/exe" | awk '{print $1}')
printf 'pid=%s\nstartToken=%s\nlocation=%s\ndigest=%s\n' \
  "$old_daemon_pid" "$old_start_token" "$old_executable_location" "$old_executable_digest" \
  >"$artifact_dir/old-executable.txt"
record_observation oldDaemonPid "$old_daemon_pid"
record_observation oldDaemonStartToken "$old_start_token"
record_observation oldExecutableDigest "$old_executable_digest"
record_observation oldExecutableLocation "$old_executable_location"
record_observation oldExecutablePath old-executable.txt
record_observation oldMetadataPath old-metadata.json
record_observation oldTranscriptPath old-transcript.log
record_observation oldSessionListPath old-session-list.json

timeout 10 curl --max-time 8 -fsS "http://127.0.0.1:$HUNK_MCP_PORT/health" >"$artifact_dir/overlap-health.json"
if health_is_minimal "$artifact_dir/overlap-health.json"; then
  record_assertion minimal-health-before passed '{"ok":true}' exact "public health is liveness-only"
else
  record_assertion minimal-health-before failed '{"ok":true}' different "public health leaked extra fields"
fi
record_observation overlapHealthPath overlap-health.json

run_expect upgrade-daemon-b 0 timeout 240 npm install -g "hunkdiff@$daemon_version_b" --registry "$REGISTRY_URL"
run_expect version-daemon-b 0 timeout 10 hunk --version
assert_contains version-b-matches "$command_dir/version-daemon-b.log" "$daemon_version_b"
new_binary=$(command -v hunk)

start_tui "$new_binary" 4 "$new_first_transcript" "$new_first_warning" new_first_wrapper
new_first_wrapper_token=$(process_start_token "$new_first_wrapper")
start_tui "$new_binary" 5 "$new_second_transcript" "$new_second_warning" new_second_wrapper
new_second_wrapper_token=$(process_start_token "$new_second_wrapper")
record_command start-new-first passed "background PTY remains live" 0 "new-first-transcript.log"
record_command start-new-second passed "background PTY remains live" 0 "new-second-transcript.log"
if ! wait_for 20 capture_client_identity "$new_first_wrapper" "$installed_binary" new_first_client new_first_client_token; then
  record_assertion new-first-client-identity failed "owned Hunk descendant" missing "could not identify first B TUI"
fi
if ! wait_for 20 capture_client_identity "$new_second_wrapper" "$installed_binary" new_second_client new_second_client_token; then
  record_assertion new-second-client-identity failed "owned Hunk descendant" missing "could not identify second B TUI"
fi
record_observation newFirstWrapperPid "$new_first_wrapper"
record_observation newFirstWrapperStartToken "$new_first_wrapper_token"
record_observation newSecondWrapperPid "$new_second_wrapper"
record_observation newSecondWrapperStartToken "$new_second_wrapper_token"
record_observation newFirstClientPid "$new_first_client"
record_observation newFirstClientStartToken "$new_first_client_token"
record_observation newSecondClientPid "$new_second_client"
record_observation newSecondClientStartToken "$new_second_client_token"
record_observation newFirstTranscriptPath new-first-transcript.log
record_observation newSecondTranscriptPath new-second-transcript.log

# The TUI renderer owns its terminal; retain stable one-shot warning evidence while both original
# interactive B processes remain in pre-authentication quiescent wait.
run_expect_nonzero incompatible-daemon-b timeout 12 "$new_binary" session list --json
cp "$command_dir/incompatible-daemon-b.log" "$artifact_dir/incompatible-warning.log"
record_observation incompatibleWarningPath incompatible-warning.log
if grep -Fq 'Close older Hunk windows' "$artifact_dir/incompatible-warning.log" && \
  wrapper_alive "$new_first_wrapper" "$new_first_wrapper_token" && \
  wrapper_alive "$new_second_wrapper" "$new_second_wrapper_token" && \
  process_identity_is "$new_first_client" "$new_first_client_token" && \
  process_identity_is "$new_second_client" "$new_second_client_token"; then
  record_assertion new-clients-incompatible passed "stable warning with both original B clients alive" present "new clients wait without replacement"
else
  record_assertion new-clients-incompatible failed "stable warning with both original B clients alive" missing "see warning and transcripts"
fi

# Observe multiple reconnect intervals while A still owns live work.
sleep 8
overlap_pid=$(metadata_pid "$metadata")
overlap_token=$(process_start_token "$overlap_pid" 2>/dev/null || true)
if [[ $overlap_pid == "$old_daemon_pid" && $overlap_token == "$old_start_token" ]] && \
  wrapper_alive "$old_wrapper" "$old_wrapper_token"; then
  record_assertion old-daemon-survived-overlap passed "same live daemon PID/start token" preserved "A remained available throughout B overlap"
else
  record_assertion old-daemon-survived-overlap failed "same live daemon PID/start token" changed "A daemon or producer disappeared"
fi
if session_pids_are "$old_binary" "$old_client" "$artifact_dir/old-overlap-session-list.json"; then
  record_assertion old-session-still-usable passed "original authenticated A client" usable "old session survived B retries"
else
  record_assertion old-session-still-usable failed "original authenticated A client" unavailable "old session stopped serving"
fi
if [[ $(find "$XDG_RUNTIME_DIR/hunk-mcp" -maxdepth 1 -name 'daemon-*.json' | wc -l) == 1 && $overlap_pid == "$old_daemon_pid" ]]; then
  record_assertion one-incumbent-metadata passed "one incumbent metadata record" one "fixed endpoint published one incumbent record"
else
  record_assertion one-incumbent-metadata failed "one incumbent metadata record" multiple "duplicate metadata evidence found"
fi

# Suspend only the exact test-owned second B client. It must miss endpoint absence and recover after
# the first B client has established a healthy successor.
if process_identity_is "$new_second_client" "$new_second_client_token" && \
  pidfd_signal_owned_identity "$new_second_client" "$new_second_client_token" STOP && \
  (wait_for 5 process_identity_state_is "$new_second_client" "$new_second_client_token" T || \
    wait_for 1 process_identity_state_is "$new_second_client" "$new_second_client_token" t); then
  new_second_stopped=1
  record_command suspend-new-second passed "SIGSTOP exact owned B client" 0 "new-second-transcript.log"
  record_assertion delayed-client-suspended passed "exact original second B identity stopped" stopped "test delayed one client across migration"
else
  record_command suspend-new-second failed "SIGSTOP exact owned B client" 1 "new-second-transcript.log"
  record_assertion delayed-client-suspended failed "exact original second B identity stopped" running "could not suspend owned client"
fi

reconnect_started_ms=$(date +%s%3N)
printf 'q' >&3
exec 3>&-
fd3_open=0
if wait_for 10 process_identity_gone "$old_wrapper" "$old_wrapper_token"; then
  wait "$old_wrapper" 2>/dev/null || true
  old_wrapper=
  old_wrapper_token=
  if process_identity_is "$old_client" "$old_client_token"; then
    record_assertion old-client-close failed "old client exits with wrapper" alive "surviving descendant requires cleanup"
  else
    old_client=
    old_client_token=
  fi
else
  record_assertion old-window-close failed "old test-owned wrapper exits after q" alive "old window did not close promptly"
fi

# The daemon owns its production 60-second idle shutdown. Runtime evidence shows that the same
# incumbent survives overlap and later retires after its last producer closes; source tests prove
# Hunk has no metadata/PID signalling authority.
if wait_for 90 process_identity_gone "$old_daemon_pid" "$old_start_token"; then
  record_assertion old-daemon-retired-after-quiescence passed "incumbent identity retires after quiescence" retired "production idle shutdown completed"
else
  record_assertion old-daemon-retired-after-quiescence failed "incumbent identity retires after quiescence" alive "incumbent exceeded quiescent deadline"
fi

if ! wait_for 30 successor_metadata_ready "$metadata" "$old_daemon_pid" "$old_start_token"; then
  record_assertion successor-ready failed "new daemon identity and health" missing "first B client did not establish successor"
fi
first_recovered_list="$artifact_dir/first-recovered-session-list.json"
if wait_for 20 session_pids_are "$new_binary" "$new_first_client" "$first_recovered_list"; then
  record_assertion first-client-established-successor passed "exact original first B client" present "first waiter registered before delayed client resumed"
else
  record_assertion first-client-established-successor failed "exact original first B client" missing "successor ownership was not established by first client"
fi
record_observation firstRecoveredSessionListPath first-recovered-session-list.json

if [[ $new_second_stopped == 1 ]] && process_identity_is "$new_second_client" "$new_second_client_token" && \
  pidfd_signal_owned_identity "$new_second_client" "$new_second_client_token" CONT && \
  wait_for 5 process_identity_not_stopped "$new_second_client" "$new_second_client_token"; then
  new_second_stopped=0
  record_command resume-new-second passed "SIGCONT exact owned B client" 0 "new-second-transcript.log"
else
  record_command resume-new-second failed "SIGCONT exact owned B client" 1 "new-second-transcript.log"
fi

recovered_list="$artifact_dir/recovered-session-list.json"
if wait_for 30 session_pids_are "$new_binary" "$new_first_client,$new_second_client" "$recovered_list"; then
  record_assertion new-producers-registered passed "two exact original B client PIDs" present "both waiting clients registered"
else
  record_assertion new-producers-registered failed "two exact original B client PIDs" missing "B clients did not recover"
fi
if process_identity_is "$new_first_client" "$new_first_client_token" && \
  process_identity_is "$new_second_client" "$new_second_client_token"; then
  record_assertion delayed-client-recovered passed "original delayed PID/start token registered" unchanged "stopped B client authenticated without restart"
else
  record_assertion delayed-client-recovered failed "original delayed PID/start token registered" changed "delayed B process identity was lost"
fi
run_expect recovered-session-list 0 timeout 10 "$new_binary" session list --json
cp "$command_dir/recovered-session-list.log" "$recovered_list"

cp "$metadata" "$artifact_dir/recovered-metadata.json"
new_daemon_pid=$(metadata_pid "$metadata")
new_start_token=$(process_start_token "$new_daemon_pid")
new_executable_location=$(readlink "/proc/$new_daemon_pid/exe")
new_executable_digest=$(timeout 10 sha256sum "/proc/$new_daemon_pid/exe" | awk '{print $1}')
printf 'pid=%s\nstartToken=%s\nlocation=%s\ndigest=%s\n' \
  "$new_daemon_pid" "$new_start_token" "$new_executable_location" "$new_executable_digest" \
  >"$artifact_dir/new-executable.txt"
record_observation newDaemonPid "$new_daemon_pid"
record_observation newDaemonStartToken "$new_start_token"
record_observation newExecutableDigest "$new_executable_digest"
record_observation newExecutableLocation "$new_executable_location"
record_observation newExecutablePath new-executable.txt
record_observation recoveredMetadataPath recovered-metadata.json
record_observation recoveredSessionListPath recovered-session-list.json
record_observation reconnectDurationMs "$(( $(date +%s%3N) - reconnect_started_ms ))"

installed_digest=$(timeout 10 sha256sum "$installed_binary" | awk '{print $1}')
if [[ ($new_daemon_pid != "$old_daemon_pid" || $new_start_token != "$old_start_token") && \
  $old_executable_digest == "$daemon_binary_sha256_a" && \
  $new_executable_digest == "$daemon_binary_sha256_b" && \
  $new_executable_digest == "$installed_digest" && \
  $new_executable_digest != "$old_executable_digest" ]]; then
  record_assertion new-daemon-binary passed "manifest-bound A/B executables and successor identity" matched "runtime binaries match compiled fixture provenance"
else
  record_assertion new-daemon-binary failed "manifest-bound A/B executables and successor identity" mismatched "runtime executable evidence differs from fixture manifest"
fi
if wrapper_alive "$new_first_wrapper" "$new_first_wrapper_token" && \
  wrapper_alive "$new_second_wrapper" "$new_second_wrapper_token"; then
  record_assertion new-clients-not-relaunched passed "original B wrappers remain alive" unchanged "B recovered without app restart"
else
  record_assertion new-clients-not-relaunched failed "original B wrappers remain alive" exited "a waiting B wrapper disappeared"
fi

timeout 10 curl --max-time 8 -fsS "http://127.0.0.1:$HUNK_MCP_PORT/health" >"$artifact_dir/recovered-health.json"
if health_is_minimal "$artifact_dir/recovered-health.json"; then
  record_assertion minimal-health-after passed '{"ok":true}' exact "successor health is liveness-only"
else
  record_assertion minimal-health-after failed '{"ok":true}' different "successor health leaked extra fields"
fi
record_observation recoveredHealthPath recovered-health.json

scenario_finish
