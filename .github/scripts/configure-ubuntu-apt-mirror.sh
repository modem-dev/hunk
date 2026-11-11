#!/usr/bin/env bash
# Add a last-resort runner apt mirror without changing official preference, suites, or archive trust.
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

# Check each deb822 stanza, not just matching lines. Reject folded URI/key fields rather than
# overlooking additional values on continuation lines. Leave the original source file unchanged.
awk '
  BEGIN { RS = ""; FS = "\n" }
  {
    uris = keys = fields = 0; field = ""
    for (i = 1; i <= NF; i++) {
      line = $i
      if (line ~ /^#/) continue
      if (line ~ /^[ \t]/) {
        if (field == "uris" || field == "signed-by" || field == "trusted" ||
            field == "check-valid-until" || field == "check-date") invalid = 1
        continue
      }
      colon = index(line, ":")
      if (!colon) { invalid = 1; continue }
      field = tolower(substr(line, 1, colon - 1))
      value = substr(line, colon + 1)
      gsub(/^[ \t]+|[ \t\r]+$/, "", value)
      fields++
      if (field == "uris") {
        uris++
        if (value != "mirror+file:/etc/apt/apt-mirrors.txt") invalid = 1
      }
      if (field == "signed-by") {
        keys++
        if (value != "/usr/share/keyrings/ubuntu-archive-keyring.gpg") invalid = 1
      }
      if (field == "trusted" && tolower(value) != "no") invalid = 1
      if ((field == "check-valid-until" || field == "check-date") && tolower(value) != "yes") invalid = 1
    }
    if (fields) {
      stanzas++
      if (uris != 1 || keys != 1) invalid = 1
    }
  }
  END { exit (!stanzas || invalid) }
' "$sources" || fail "unexpected Ubuntu source URI or archive trust configuration"

# Require the image official entries and their explicit priorities; permit our own fourth entry
# on repeat invocation. Unknown entries/metadata must fail before either file is changed.
awk '
  BEGIN {
    expected["http://azure.archive.ubuntu.com/ubuntu/"] = "priority:1"
    expected["https://archive.ubuntu.com/ubuntu/"] = "priority:2"
    expected["https://security.ubuntu.com/ubuntu/"] = "priority:3"
    expected["https://mirrors.edge.kernel.org/ubuntu/"] = "priority:4"
  }
  /^[ \t]*($|#)/ { next }
  { if (NF != 2 || !($1 in expected) || $2 != expected[$1] || seen[$1]++) invalid = 1 }
  END {
    for (uri in expected) if (expected[uri] != "priority:4" && seen[uri] != 1) invalid = 1
    exit invalid
  }
' "$mirrors" || fail "unexpected Ubuntu mirror list or priorities"

# apt-transport-mirror(1): lower priorities are tried first, per file; equal priorities are random.
# A literal TAB separates URI and metadata. kernel.org is used only after all official failures.
{
  printf '%s\tpriority:%s\n' 'http://azure.archive.ubuntu.com/ubuntu/' 1
  printf '%s\tpriority:%s\n' 'https://archive.ubuntu.com/ubuntu/' 2
  printf '%s\tpriority:%s\n' 'https://security.ubuntu.com/ubuntu/' 3
  printf '%s\tpriority:%s\n' 'https://mirrors.edge.kernel.org/ubuntu/' 4
} > "$mirrors"
# Sort after image retry settings. Incomplete index refreshes must fail, not use stale lists.
cat > "$apt_dir/apt.conf.d/zzz-hunk-ci" <<'EOF'
Acquire::Retries "1";
Acquire::http::Timeout "20";
Acquire::https::Timeout "20";
APT::Update::Error-Mode "any";
EOF
printf '%s\n' 'Ubuntu apt mirrors: official priorities 1/2/3; kernel.org fallback priority 4'
