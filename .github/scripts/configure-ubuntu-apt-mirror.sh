#!/usr/bin/env bash
# Route runner apt installs around Canonical DNS outages without changing suites or archive trust.
set -euo pipefail

# An alternate apt directory lets fixture tests exercise the same validation without sudo.
apt_dir="${1:-/etc/apt}"
sources="$apt_dir/sources.list.d/ubuntu.sources"
mirrors="$apt_dir/apt-mirrors.txt"

fail() {
  echo "Ubuntu apt mirror bootstrap: $*" >&2
  exit 1
}

[[ $# -le 1 ]] || fail "expected at most one apt directory"
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || fail "expected a Linux x64 runner"
[[ -f "$sources" && -f "$mirrors" && -d "$apt_dir/apt.conf.d" ]] || fail "missing runner apt configuration"

# Fail rather than guessing how a changed runner image routes Ubuntu repositories.
awk '
  $1 == "URIs:" {
    found = 1
    if (NF != 2 || $2 != "mirror+file:/etc/apt/apt-mirrors.txt") invalid = 1
  }
  END { exit (!found || invalid) }
' "$sources" || fail "unexpected Ubuntu source URI"
grep -Fxq 'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg' "$sources" || fail "missing Ubuntu archive keyring"

seen=false
while read -r uri rest || [[ -n "$uri" ]]; do
  [[ -z "$uri" || "$uri" == \#* ]] && continue
  case "$uri" in
    http://azure.archive.ubuntu.com/ubuntu/ | https://archive.ubuntu.com/ubuntu/ | https://security.ubuntu.com/ubuntu/ | https://mirrors.edge.kernel.org/ubuntu/)
      seen=true
      ;;
    *) fail "unexpected mirror: $uri" ;;
  esac
done < "$mirrors"
[[ "$seen" == true ]] || fail "empty Ubuntu mirror list"

# Keep the image's suites, components, Signed-By, and apt's signature/date checks intact.
printf '%s\n' 'https://mirrors.edge.kernel.org/ubuntu/' > "$mirrors"
# Sort after image-supplied retry settings. Incomplete index refreshes must fail, not use stale lists.
cat > "$apt_dir/apt.conf.d/zzz-hunk-ci" <<'EOF'
Acquire::Retries "1";
Acquire::http::Timeout "20";
Acquire::https::Timeout "20";
APT::Update::Error-Mode "any";
EOF
printf 'Ubuntu apt mirror: %s\n' 'https://mirrors.edge.kernel.org/ubuntu/'
