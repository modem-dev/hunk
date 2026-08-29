#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

cache=${1:?cache directory required}
pins=${2:?pins file required}
mkdir -p "$cache/downloads" "$cache/base"

pin_value() {
  jq -er "$1" "$pins"
}

# Download through a partial file so an interrupted fetch never becomes a trusted cache hit.
download_checked() {
  local name=$1 url=$2 expected=$3
  local destination="$cache/downloads/$name"
  if [[ -f $destination ]]; then
    if echo "$expected  $destination" | sha256sum -c - >/dev/null; then
      return
    fi
    rm -f "$destination"
    echo "Cached $name failed its pinned checksum; downloading it again." >&2
  fi
  local partial="${destination}.partial.$$"
  trap 'rm -f "$partial"' RETURN
  curl --fail --show-error --location --connect-timeout 15 --max-time 600 --retry 3 \
    -o "$partial" "$url"
  echo "$expected  $partial" | sha256sum -c - >/dev/null
  mv "$partial" "$destination"
  trap - RETURN
}

fc_version=$(pin_value '.firecracker.version')
download_checked \
  "firecracker-${fc_version}.tgz" \
  "$(pin_value '.firecracker.url')" \
  "$(pin_value '.firecracker.sha256')"
download_checked vmlinux "$(pin_value '.kernel.url')" "$(pin_value '.kernel.sha256')"
download_checked rootfs.squashfs "$(pin_value '.rootfs.url')" "$(pin_value '.rootfs.sha256')"
download_checked node.tar.xz "$(pin_value '.node.url')" "$(pin_value '.node.sha256')"

extract_dir=$(mktemp -d)
trap 'rm -rf "$extract_dir"' RETURN
tar --no-same-owner -xzf "$cache/downloads/firecracker-${fc_version}.tgz" -C "$extract_dir"
install -m 0755 \
  "$extract_dir/release-v${fc_version}-x86_64/firecracker-v${fc_version}-x86_64" \
  "$cache/base/firecracker.partial.$$"
mv "$cache/base/firecracker.partial.$$" "$cache/base/firecracker"
trap - RETURN
rm -rf "$extract_dir"
cp "$cache/downloads/vmlinux" "$cache/base/vmlinux.partial"
mv "$cache/base/vmlinux.partial" "$cache/base/vmlinux"

# Older harness revisions cached an SSH identity; current runs use an ephemeral key.
rm -f "$cache/base/id_ed25519" "$cache/base/id_ed25519.pub"

base=$cache/base/rootfs.base.ext4
base_digest=$cache/base/rootfs.base.ext4.sha256
base_identity=$cache/base/rootfs.base.identity
# Rebuild whenever the inputs or image-building logic changes, not merely when the file is absent.
identity=$(
  {
    sha256sum "$pins" "$0"
    jq -c '{rootfs: .rootfs.sha256, node: .node.sha256, kernel: .kernel.sha256}' "$pins"
  } | sha256sum | cut -d' ' -f1
)
if [[ ! -f $base_identity || $(cat "$base_identity") != "$identity" ]]; then
  rm -f "$base" "$base_digest" "$base_identity"
fi
if [[ -f $base && -f $base_digest ]]; then
  (cd "$(dirname "$base")" && sha256sum -c "$(basename "$base_digest")" >/dev/null) || {
    rm -f "$base" "$base_digest" "$base_identity"
  }
fi

if [[ ! -f $base ]]; then
  # Expand the read-only rootfs into a sparse ext4 image that each scenario can clone and mutate.
  build_dir=$(mktemp -d)
  partial="${base}.partial.$$"
  cleanup_base() {
    rm -rf "$build_dir" "$partial"
  }
  trap cleanup_base RETURN
  unsquashfs -d "$build_dir/root" "$cache/downloads/rootfs.squashfs" >/dev/null
  mkdir -p "$build_dir/root/root/.ssh" "$build_dir/root/opt" "$build_dir/root/etc/systemd/network"
  : >"$build_dir/root/root/.ssh/authorized_keys"
  chmod 0700 "$build_dir/root/root/.ssh"
  chmod 0600 "$build_dir/root/root/.ssh/authorized_keys"
  tar --no-same-owner -xJf "$cache/downloads/node.tar.xz" -C "$build_dir/root/opt"
  node_version=$(pin_value '.node.version')
  ln -s "node-v${node_version}-linux-x64" "$build_dir/root/opt/node"
  cat >"$build_dir/root/etc/systemd/network/10-eth0.network" <<'NETWORK'
[Match]
Name=eth0

[Network]
Address=172.16.0.2/30
Gateway=172.16.0.1
DNS=1.1.1.1
NETWORK
  printf 'nameserver 1.1.1.1\noptions single-request-reopen\n' >"$build_dir/root/etc/resolv.conf"
  truncate -s 4G "$partial"
  mkfs.ext4 -q -d "$build_dir/root" -F "$partial"
  e2fsck -fn "$partial" >/dev/null
  mv "$partial" "$base"
  (cd "$(dirname "$base")" && sha256sum "$(basename "$base")" >"$(basename "$base_digest").partial")
  printf '%s\n' "$identity" >"${base_identity}.partial"
  mv "${base_digest}.partial" "$base_digest"
  mv "${base_identity}.partial" "$base_identity"
  trap - RETURN
  rm -rf "$build_dir"
fi

(cd "$(dirname "$base")" && sha256sum -c "$(basename "$base_digest")" >/dev/null)
