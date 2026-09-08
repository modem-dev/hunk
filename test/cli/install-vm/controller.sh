#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

cache=/cache
fixtures=/fixtures
artifacts=/artifacts
run_root=$(mktemp -d /tmp/hunk-install-vm.XXXXXX)
export HOME="$run_root/home"
export npm_config_cache="$run_root/npm-cache"
mkdir -p "$HOME" "$npm_config_cache"
tap=hunkvm0
subnet=172.16.0.0/30
controller_ip=172.16.0.1
guest_ip=172.16.0.2
fc_pid=
registry_pid=
http_pid=
uplink=
network_ready=0

# Let daemons and Firecracker clean up normally, then bound teardown with SIGKILL.
terminate_process() {
  local pid=$1
  [[ -n $pid ]] || return 0
  kill -TERM "$pid" 2>/dev/null || return 0
  for ((attempt = 0; attempt < 50; attempt += 1)); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  local status=$?
  set +e
  terminate_process "$fc_pid"
  terminate_process "$registry_pid"
  terminate_process "$http_pid"
  if [[ $network_ready == 1 ]]; then
    iptables -t nat -D POSTROUTING -s "$subnet" -o "$uplink" -j MASQUERADE 2>/dev/null
    iptables -D FORWARD -i "$tap" -o "$uplink" -j ACCEPT 2>/dev/null
    iptables -D FORWARD -i "$uplink" -o "$tap" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null
  fi
  ip link del "$tap" 2>/dev/null
  rm -rf "$run_root"
  if [[ ${HOST_UID:-} =~ ^[0-9]+$ && ${HOST_GID:-} =~ ^[0-9]+$ ]]; then
    chown -R "$HOST_UID:$HOST_GID" "$cache" "$artifacts" 2>/dev/null
  fi
  trap - EXIT
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$cache" "$artifacts/scenarios"
# Take temporary ownership inside the container; cleanup restores the invoking host user.
if [[ ${HOST_UID:-} =~ ^[0-9]+$ && ${HOST_GID:-} =~ ^[0-9]+$ ]]; then
  chown -R 0:0 "$cache" "$artifacts"
fi
/opt/install-vm/guest/prepare-base-image.sh "$cache" /opt/install-vm/pins.json
ssh-keygen -q -t ed25519 -f "$run_root/id_ed25519" -N ''
chmod 0600 "$run_root/id_ed25519"

# Keep Hunk fixtures local while proxying only uncached third-party dependencies to npm.
cat >"$run_root/verdaccio.yml" <<'YAML'
storage: /tmp/verdaccio-storage
max_body_size: 100mb
web:
  enable: false
auth:
  htpasswd:
    file: /tmp/verdaccio.htpasswd
    max_users: 10
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  'hunkdiff':
    access: $all
    publish: $authenticated
    unpublish: $authenticated
  'hunkdiff-*':
    access: $all
    publish: $authenticated
    unpublish: $authenticated
  '@*/*':
    access: $all
    publish: $authenticated
    unpublish: $authenticated
    proxy: npmjs
  '**':
    access: $all
    publish: $authenticated
    unpublish: $authenticated
    proxy: npmjs
log:
  type: stdout
  format: pretty
  level: warn
YAML
verdaccio --config "$run_root/verdaccio.yml" --listen 0.0.0.0:4873 >"$artifacts/registry.log" 2>&1 &
registry_pid=$!
python3 -m http.server 18080 --bind 0.0.0.0 --directory "$fixtures/http" >"$artifacts/http.log" 2>&1 &
http_pid=$!

for ((attempt = 0; attempt < 60; attempt += 1)); do
  if curl -fsS http://127.0.0.1:4873/-/ping >/dev/null; then break; fi
  kill -0 "$registry_pid" 2>/dev/null || { tail -100 "$artifacts/registry.log" >&2; exit 1; }
  sleep 0.5
done
curl -fsS http://127.0.0.1:4873/-/ping >/dev/null
user_response=$(curl -fsS -X PUT -H 'content-type: application/json' \
  -d '{"name":"hunk-install-vm","password":"hunk-install-vm","email":"install-vm@hunk.dev","type":"user","roles":[]}' \
  http://127.0.0.1:4873/-/user/org.couchdb.user:hunk-install-vm)
token=$(jq -er '.token' <<<"$user_response")
printf '//127.0.0.1:4873/:_authToken=%s\nregistry=http://127.0.0.1:4873/\n' "$token" >"$run_root/npmrc"

# Reverify staged tarballs at the trust boundary before publishing them into the guest registry.
jq -r '.packages[] | [.sha256, .tarball] | @tsv' "$fixtures/fixture-manifest.json" | while IFS=$'\t' read -r expected tarball; do
  [[ $(basename "$tarball") == "$tarball" && $tarball == *.tgz ]] || {
    echo "Unsafe fixture tarball name: $tarball" >&2
    exit 1
  }
  echo "$expected  $fixtures/packages/$tarball" | sha256sum -c - >/dev/null
  npm publish "$fixtures/packages/$tarball" \
    --registry http://127.0.0.1:4873 \
    --userconfig "$run_root/npmrc" \
    --tag latest \
    --ignore-scripts >/dev/null
done

# NAT the guest through the controller namespace; local scenarios later remove the guest route.
uplink=$(ip route show default | awk 'NR == 1 { print $5 }')
[[ -n $uplink ]] || { echo 'Could not resolve controller uplink.' >&2; exit 1; }
ip tuntap add "$tap" mode tap
ip addr add "$controller_ip/30" dev "$tap"
ip link set "$tap" up
[[ $(cat /proc/sys/net/ipv4/ip_forward) == 1 ]] || {
  echo 'Controller network namespace does not have IP forwarding enabled.' >&2
  exit 1
}
iptables -A FORWARD -i "$tap" -o "$uplink" -j ACCEPT
iptables -A FORWARD -i "$uplink" -o "$tap" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
iptables -t nat -A POSTROUTING -s "$subnet" -o "$uplink" -j MASQUERADE
network_ready=1

ssh_options=(
  -i "$run_root/id_ed25519"
  -o BatchMode=yes
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o ConnectTimeout=2
  -o ServerAliveInterval=5
  -o ServerAliveCountMax=3
  -o LogLevel=ERROR
)

selected=${INSTALL_VM_SCENARIOS:-}
[[ -n $selected ]] || selected=$(jq -r '[.scenarios[].id] | join(",")' /opt/install-vm/scenarios.json)
pnpm_version=$(jq -er '.pnpmVersion' /opt/install-vm/pins.json)
historical_hunkdiff_version=$(jq -er '.historical.hunkdiffVersion' /opt/install-vm/pins.json)
historical_bun_version=$(jq -er '.historical.bunVersion' /opt/install-vm/pins.json)
IFS=',' read -r -a scenario_ids <<<"$selected"

# Each scenario mutates a fresh sparse clone, so package stores and lifecycle scripts cannot leak.
for scenario_id in "${scenario_ids[@]}"; do
  scenario=$(jq -ce --arg id "$scenario_id" '.scenarios[] | select(.id == $id)' /opt/install-vm/scenarios.json) || {
    echo "Unknown scenario: $scenario_id" >&2
    exit 1
  }
  script=$(jq -r '.script' <<<"$scenario")
  profile=$(jq -r '.profile' <<<"$scenario")
  network=$(jq -r '.network' <<<"$scenario")
  scenario_dir="$artifacts/scenarios/$scenario_id"
  mkdir -p "$scenario_dir"
  disk="$run_root/$scenario_id.ext4"
  socket="$run_root/$scenario_id.socket"
  config="$run_root/$scenario_id.json"
  cp --reflink=auto --sparse=always "$cache/base/rootfs.base.ext4" "$disk"
  debugfs -w -R 'rm /root/.ssh/authorized_keys' "$disk" >/dev/null 2>&1
  debugfs -w -R "write $run_root/id_ed25519.pub /root/.ssh/authorized_keys" "$disk" >/dev/null 2>&1
  cat >"$config" <<JSON
{
  "boot-source": {
    "kernel_image_path": "$cache/base/vmlinux",
    "boot_args": "console=ttyS0 reboot=k panic=1 pci=off"
  },
  "drives": [{
    "drive_id": "rootfs",
    "path_on_host": "$disk",
    "is_root_device": true,
    "is_read_only": false
  }],
  "network-interfaces": [{
    "iface_id": "net1",
    "guest_mac": "06:00:AC:10:00:02",
    "host_dev_name": "$tap"
  }],
  "machine-config": { "vcpu_count": 2, "mem_size_mib": 2048 }
}
JSON

  started_ms=$(date +%s%3N)
  "$cache/base/firecracker" --api-sock "$socket" --config-file "$config" \
    >"$scenario_dir/firecracker.console.log" 2>&1 &
  fc_pid=$!
  ready=0
  deadline=$((SECONDS + 90))
  while ((SECONDS < deadline)); do
    if ssh "${ssh_options[@]}" "root@$guest_ip" true >/dev/null 2>&1; then
      ready=1
      break
    fi
    kill -0 "$fc_pid" 2>/dev/null || break
    sleep 1
  done

  guest_status=125
  if [[ $ready == 1 ]]; then
    ssh "${ssh_options[@]}" "root@$guest_ip" 'rm -rf /tmp/hunk-install-vm /var/tmp/hunk-install-vm; mkdir -p /tmp/hunk-install-vm /var/tmp/hunk-install-vm'
    scp "${ssh_options[@]}" \
      /opt/install-vm/guest/scenario-lib.sh "/opt/install-vm/scenarios/$script" \
      "root@$guest_ip:/tmp/hunk-install-vm/" >/dev/null
    # The expanded address is a fixed controller constant.
    # shellcheck disable=SC2029
    ssh "${ssh_options[@]}" "root@$guest_ip" \
      "ip route replace default via $controller_ip dev eth0; rm -f /etc/resolv.conf; printf 'nameserver 1.1.1.1\\noptions single-request-reopen\\n' > /etc/resolv.conf"
    # Local scenarios can reach controller fixtures over the connected subnet but not the internet.
    if [[ $network == local ]]; then
      ssh "${ssh_options[@]}" "root@$guest_ip" "ip route del default 2>/dev/null || true"
    fi
    set +e
    timeout --signal=TERM --kill-after=10s 10m \
      ssh "${ssh_options[@]}" "root@$guest_ip" \
        "INSTALL_VM_PROFILE='$profile' PNPM_VERSION='$pnpm_version' HISTORICAL_HUNKDIFF_VERSION='$historical_hunkdiff_version' HISTORICAL_BUN_VERSION='$historical_bun_version' REGISTRY_URL='http://$controller_ip:4873' HTTP_URL='http://$controller_ip:18080' bash '/tmp/hunk-install-vm/$script'" \
        >"$scenario_dir/guest.log" 2>&1
    guest_status=$?
    set -e
    scp -r "${ssh_options[@]}" "root@$guest_ip:/var/tmp/hunk-install-vm/." "$scenario_dir/" \
      >/dev/null 2>&1 || true
  else
    printf 'Firecracker guest did not become SSH-ready before the deadline.\n' >"$scenario_dir/guest.log"
  fi

  # Missing protocol files become explicit failures instead of disappearing during aggregation.
  [[ -f $scenario_dir/assertions.tsv ]] || printf 'guest-protocol\tfailed\tresult artifact\tmissing\tguest did not return structured assertions\n' >"$scenario_dir/assertions.tsv"
  [[ -f $scenario_dir/commands.tsv ]] || : >"$scenario_dir/commands.tsv"
  [[ -f $scenario_dir/observations.tsv ]] || : >"$scenario_dir/observations.tsv"
  terminate_process "$fc_pid"
  fc_pid=
  rm -f "$disk" "$socket" "$config"
  finished_ms=$(date +%s%3N)
  jq -n \
    --arg id "$scenario_id" \
    --argjson exitCode "$guest_status" \
    --argjson durationMs "$((finished_ms - started_ms))" \
    '{id: $id, exitCode: $exitCode, durationMs: $durationMs}' \
    >"$scenario_dir/result.json"
  echo "[$scenario_id] guest exit $guest_status"
done

jq -n \
  --arg firecracker "$("$cache/base/firecracker" --version | head -n 1)" \
  --arg kernel "$(jq -r '.kernel.version' /opt/install-vm/pins.json)" \
  --arg node "$(node --version)" \
  --arg npm "$(npm --version)" \
  --arg pnpm "$pnpm_version" \
  --arg verdaccio "$(verdaccio --version)" \
  '{firecracker: $firecracker, kernel: $kernel, node: $node, npm: $npm, pnpm: $pnpm, verdaccio: $verdaccio}' \
  >"$artifacts/tools.json"
