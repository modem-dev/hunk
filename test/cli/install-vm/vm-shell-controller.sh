#!/usr/bin/env bash
# shellcheck disable=SC2317
set -Eeuo pipefail
shopt -s inherit_errexit
umask 077

cache=/cache
shell_input=/shell-input
with_hunk=${WITH_HUNK:-0}
[[ -t 0 && -t 1 ]] || { echo 'Disposable VM shell requires docker run -it.' >&2; exit 2; }
[[ ${HOST_UID:?HOST_UID is required} =~ ^[0-9]+$ ]] || { echo 'HOST_UID must be numeric.' >&2; exit 2; }
[[ ${HOST_GID:?HOST_GID is required} =~ ^[0-9]+$ ]] || { echo 'HOST_GID must be numeric.' >&2; exit 2; }
((HOST_UID <= 4294967294 && HOST_GID <= 4294967294)) || {
  echo 'HOST_UID and HOST_GID exceed the supported range.' >&2
  exit 2
}
[[ $with_hunk == 0 || $with_hunk == 1 ]] || { echo 'WITH_HUNK must be 0 or 1.' >&2; exit 2; }
[[ -d $shell_input/fixtures && ! -L $shell_input/fixtures ]] || {
  echo 'Staged VM fixtures are missing or unsafe.' >&2
  exit 2
}
[[ -f $shell_input/fixtures/README.md && ! -L $shell_input/fixtures/README.md ]] || {
  echo 'Staged VM fixture index is missing or unsafe.' >&2
  exit 2
}
if [[ -n $(find "$shell_input/fixtures" -type l -print -quit) ]]; then
  echo 'Staged VM fixtures may not contain symlinks.' >&2
  exit 2
fi
if [[ $with_hunk == 1 ]]; then
  [[ -f $shell_input/hunk && ! -L $shell_input/hunk ]] || {
    echo 'Staged Hunk binary is missing or unsafe.' >&2
    exit 2
  }
  [[ -d $shell_input/hunkdiff/skills && ! -L $shell_input/hunkdiff/skills ]] || {
    echo 'Staged Hunk skills are missing or unsafe.' >&2
    exit 2
  }
fi

run_root=$(mktemp -d /tmp/hunk-vm-shell.XXXXXX)
tap=hunkvm0
controller_ip=172.16.0.1
guest_ip=172.16.0.2
egress_chain="HUNKVM_$$"
fc_pid=
ssh_pid=
uplink=
tap_created=0
egress_chain_created=0
egress_jump_rule=0
forward_in_rule=0
nat_rule=0

# Give child processes time to exit normally before forcing termination.
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

# Remove only resources this invocation successfully created.
cleanup() {
  local status=$?
  trap - EXIT HUP INT QUIT TERM WINCH
  set +e
  terminate_process "$ssh_pid"
  terminate_process "$fc_pid"
  if [[ $nat_rule == 1 ]]; then
    iptables -t nat -D POSTROUTING -s "$guest_ip/32" -o "$uplink" -j MASQUERADE 2>/dev/null
  fi
  if [[ $forward_in_rule == 1 ]]; then
    iptables -D FORWARD -d "$guest_ip/32" -i "$uplink" -o "$tap" \
      -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null
  fi
  if [[ $egress_jump_rule == 1 ]]; then
    iptables -D FORWARD -i "$tap" -o "$uplink" -j "$egress_chain" 2>/dev/null
  fi
  if [[ $egress_chain_created == 1 ]]; then
    iptables -F "$egress_chain" 2>/dev/null
    iptables -X "$egress_chain" 2>/dev/null
  fi
  if [[ $tap_created == 1 ]]; then
    ip link del "$tap" 2>/dev/null
  fi
  rm -rf -- "$run_root"
  if [[ ${HOST_UID:-} =~ ^[0-9]+$ && ${HOST_GID:-} =~ ^[0-9]+$ ]]; then
    chown -R "$HOST_UID:$HOST_GID" "$cache" 2>/dev/null
  fi
  trap - EXIT
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 131' QUIT
trap 'exit 143' TERM
trap '[[ -n $ssh_pid ]] && kill -WINCH "$ssh_pid" 2>/dev/null || true' WINCH

mkdir -p "$cache"
/opt/install-vm/guest/prepare-base-image.sh "$cache" /opt/install-vm/pins.json

ssh-keygen -q -t ed25519 -f "$run_root/id_ed25519" -N ''
chmod 0600 "$run_root/id_ed25519"
disk="$run_root/rootfs.ext4"
socket="$run_root/firecracker.socket"
config="$run_root/firecracker.json"
cp --reflink=auto --sparse=always "$cache/base/rootfs.base.ext4" "$disk"
debugfs -w -R 'rm /root/.ssh/authorized_keys' "$disk" >/dev/null 2>&1
debugfs -w -R "write $run_root/id_ed25519.pub /root/.ssh/authorized_keys" "$disk" >/dev/null 2>&1

uplink=$(ip route show default | awk 'NR == 1 { print $5 }')
[[ -n $uplink ]] || { echo 'Could not resolve controller uplink.' >&2; exit 1; }
ip tuntap add "$tap" mode tap
tap_created=1
ip addr add "$controller_ip/30" dev "$tap"
ip link set "$tap" up
[[ $(cat /proc/sys/net/ipv4/ip_forward) == 1 ]] || {
  echo 'Controller network namespace does not have IP forwarding enabled.' >&2
  exit 1
}
# Permit public IPv4 egress while blocking host, LAN, link-local, metadata, and reserved ranges.
egress_chain_created=1
iptables -N "$egress_chain"
iptables -A "$egress_chain" ! -s "$guest_ip/32" -j DROP
for blocked_destination in \
  0.0.0.0/8 \
  10.0.0.0/8 \
  100.64.0.0/10 \
  127.0.0.0/8 \
  169.254.0.0/16 \
  172.16.0.0/12 \
  192.0.0.0/24 \
  192.0.2.0/24 \
  192.168.0.0/16 \
  198.18.0.0/15 \
  198.51.100.0/24 \
  203.0.113.0/24 \
  224.0.0.0/4 \
  240.0.0.0/4; do
  iptables -A "$egress_chain" -d "$blocked_destination" -j REJECT
done
iptables -A "$egress_chain" -s "$guest_ip/32" -j ACCEPT
egress_jump_rule=1
iptables -A FORWARD -i "$tap" -o "$uplink" -j "$egress_chain"
forward_in_rule=1
iptables -A FORWARD -d "$guest_ip/32" -i "$uplink" -o "$tap" \
  -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
nat_rule=1
iptables -t nat -A POSTROUTING -s "$guest_ip/32" -o "$uplink" -j MASQUERADE

jq -n \
  --arg kernel "$cache/base/vmlinux" \
  --arg disk "$disk" \
  --arg tap "$tap" \
  '{
    "boot-source": {
      "kernel_image_path": $kernel,
      "boot_args": "console=ttyS0 reboot=k panic=1 pci=off"
    },
    "drives": [{
      "drive_id": "rootfs",
      "path_on_host": $disk,
      "is_root_device": true,
      "is_read_only": false
    }],
    "network-interfaces": [{
      "iface_id": "net1",
      "guest_mac": "06:00:AC:10:00:02",
      "host_dev_name": $tap
    }],
    "machine-config": { "vcpu_count": 2, "mem_size_mib": 2048 }
  }' >"$config"

boot_started=$(date +%s%3N)
"$cache/base/firecracker" --api-sock "$socket" --config-file "$config" \
  >"$run_root/firecracker.console.log" 2>&1 &
fc_pid=$!
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
if [[ $ready != 1 ]]; then
  echo 'Firecracker guest did not become SSH-ready before the deadline.' >&2
  tail -100 "$run_root/firecracker.console.log" >&2 || true
  exit 1
fi

# The expanded address is a fixed controller constant.
# shellcheck disable=SC2029
ssh "${ssh_options[@]}" "root@$guest_ip" \
  "ip route replace default via $controller_ip dev eth0; rm -f /etc/resolv.conf; printf 'nameserver 1.1.1.1\\noptions single-request-reopen\\n' > /etc/resolv.conf"

scp -r "${ssh_options[@]}" "$shell_input/fixtures" "root@$guest_ip:/tmp/" >/dev/null
ssh "${ssh_options[@]}" "root@$guest_ip" \
  'rm -rf /root/fixtures; install -d -m 0700 /root/fixtures; cp -R /tmp/fixtures/. /root/fixtures/; test -f /root/fixtures/README.md; test -f /root/fixtures/benchmarks/balanced-changeset.patch; rm -rf /tmp/fixtures'
echo 'Fixtures are available under /root/fixtures.'

if [[ $with_hunk == 1 ]]; then
  scp -r "${ssh_options[@]}" "$shell_input/hunk" "$shell_input/hunkdiff" \
    "root@$guest_ip:/tmp/" >/dev/null
  ssh "${ssh_options[@]}" "root@$guest_ip" \
    'install -m 0755 /tmp/hunk /usr/local/bin/hunk; rm -rf /usr/local/bin/hunkdiff; install -d -m 0755 /usr/local/bin/hunkdiff; cp -R /tmp/hunkdiff/skills /usr/local/bin/hunkdiff/skills; test -f /usr/local/bin/hunkdiff/skills/hunk-review/SKILL.md; /usr/local/bin/hunk --version; rm -rf /tmp/hunk /tmp/hunkdiff'
  echo 'Installed the current checkout as /usr/local/bin/hunk.'
fi

boot_finished=$(date +%s%3N)
printf 'Disposable Ubuntu 24.04 VM ready in %d.%03ds. Exit the shell to destroy it.\n' \
  "$(((boot_finished - boot_started) / 1000))" "$(((boot_finished - boot_started) % 1000))"
set +e
ssh "${ssh_options[@]}" -tt "root@$guest_ip" \
  'export PATH=/opt/node/bin:$PATH; exec bash -l' </dev/tty &
ssh_pid=$!
while true; do
  wait "$ssh_pid"
  status=$?
  kill -0 "$ssh_pid" 2>/dev/null || break
done
ssh_pid=
set -e
exit "$status"
