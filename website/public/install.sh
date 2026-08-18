#!/bin/sh
#
# Hunk installer — https://hunk.dev
#
# Downloads the prebuilt Hunk release archive for this machine, verifies it against the
# release's SHA256SUMS, and installs it into ~/.hunk (binary at ~/.hunk/bin/hunk, bundled
# agent skills beside it at ~/.hunk/skills, which is where `hunk skill path` looks).
#
# Usage:
#   curl -fsSL https://hunk.dev/install.sh | sh
#   curl -fsSL https://hunk.dev/install.sh | sh -s -- 0.19.0
#   curl -fsSL https://hunk.dev/install.sh | sh -s -- --no-modify-path
#
# Environment:
#   HUNK_VERSION          version to install (default: the newest GitHub release)
#   HUNK_INSTALL_DIR      directory to install the binary into (default: $HOME/.hunk/bin)
#   HUNK_NO_MODIFY_PATH   set to 1 to leave shell startup files alone
#
# macOS and Linux only. On Windows, install with `npm install -g hunkdiff`.
#
# Everything below only defines functions; the last line runs main. A partially delivered
# script therefore dies on a syntax error instead of executing a truncated prefix.

set -eu

REPO="modem-dev/hunk"
RELEASES_API="https://api.github.com/repos/${REPO}/releases/latest"
DOWNLOAD_BASE="https://github.com/${REPO}/releases/download"

# --------------------------------------------------------------------------------------
# Output helpers
# --------------------------------------------------------------------------------------

info() {
	printf '%s\n' "$1"
}

warn() {
	printf 'warning: %s\n' "$1" >&2
}

fail() {
	printf 'error: %s\n' "$1" >&2
	exit 1
}

usage() {
	cat <<'EOF'
Install Hunk, the terminal diff viewer.

Usage:
  install.sh [version] [options]

Arguments:
  version              release to install, for example 0.19.0 (default: newest release)

Options:
  --no-modify-path     do not add the install directory to your shell startup files
  -h, --help           show this help

Environment:
  HUNK_VERSION         same as the positional version argument
  HUNK_INSTALL_DIR     directory to install the binary into (default: $HOME/.hunk/bin)
  HUNK_NO_MODIFY_PATH  set to 1 for --no-modify-path

macOS and Linux only. On Windows, install with `npm install -g hunkdiff`.
EOF
}

# --------------------------------------------------------------------------------------
# Platform detection
# --------------------------------------------------------------------------------------

# Print the release archive's OS token, or fail with the npm fallback for anything unsupported.
detect_os() {
	os="$(uname -s)"
	case "$os" in
	Darwin) printf 'darwin\n' ;;
	Linux) printf 'linux\n' ;;
	*)
		fail "Unsupported operating system: ${os}. Install Hunk with \`npm install -g hunkdiff\` instead."
		;;
	esac
}

# Print the release archive's CPU token for this machine.
#
# On Apple silicon a Rosetta-translated shell reports x86_64 even though the native binary is
# the arm64 one, so `sysctl.proc_translated` corrects the answer back to the real hardware.
detect_arch() {
	arch="$(uname -m)"
	case "$arch" in
	x86_64 | amd64)
		if [ "$(uname -s)" = "Darwin" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
			printf 'arm64\n'
		else
			printf 'x64\n'
		fi
		;;
	arm64 | aarch64)
		printf 'arm64\n'
		;;
	*)
		fail "Unsupported architecture: ${arch}. Install Hunk with \`npm install -g hunkdiff\` instead."
		;;
	esac
}

# --------------------------------------------------------------------------------------
# Downloading
# --------------------------------------------------------------------------------------

# Download one URL to one path, returning non-zero when the server refuses it.
download() {
	if [ "$downloader" = "curl" ]; then
		curl -fsSL "$1" -o "$2"
	else
		wget -q -O "$2" "$1"
	fi
}

# Print one URL's body, returning non-zero when the server refuses it.
fetch() {
	if [ "$downloader" = "curl" ]; then
		curl -fsSL "$1"
	else
		wget -q -O - "$1"
	fi
}

# --------------------------------------------------------------------------------------
# Already-current check
# --------------------------------------------------------------------------------------

# Print one Hunk binary's version, or nothing when it cannot run.
installed_version() {
	[ -x "$1" ] || return 0
	"$1" --version 2>/dev/null | tr -d 'v \t\r' | head -n 1
}

# --------------------------------------------------------------------------------------
# PATH helpers
# --------------------------------------------------------------------------------------

# Append one line to one file unless an equivalent line is already there. Prints what it did.
add_path_line() {
	rc_file="$1"
	line="$2"
	if [ -f "$rc_file" ] && grep -Fq "$bin_dir" "$rc_file"; then
		info "${rc_file} already puts ${bin_dir} on PATH."
		return 0
	fi

	mkdir -p "$(dirname "$rc_file")"
	printf '\n# Added by the Hunk installer (https://hunk.dev)\n%s\n' "$line" >>"$rc_file"
	info "Added ${bin_dir} to PATH in ${rc_file}."
}

# Print the first of the given candidate startup files that exists, or the first candidate.
first_existing() {
	fallback="$1"
	for candidate in "$@"; do
		if [ -f "$candidate" ]; then
			printf '%s\n' "$candidate"
			return 0
		fi
	done
	printf '%s\n' "$fallback"
}

# --------------------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------------------

main() {
	version="${HUNK_VERSION:-}"
	no_modify_path="${HUNK_NO_MODIFY_PATH:-0}"

	while [ "$#" -gt 0 ]; do
		case "$1" in
		-h | --help)
			usage
			exit 0
			;;
		--no-modify-path)
			no_modify_path=1
			;;
		-*)
			fail "Unknown option: $1 (run with --help to see the supported options)"
			;;
		*)
			version="$1"
			;;
		esac
		shift
	done

	# Release tags are spelled `v1.2.3`; asset names and `--version` output are not.
	version="${version#v}"

	os="$(detect_os)"
	arch="$(detect_arch)"
	package_name="hunkdiff-${os}-${arch}"
	archive_name="${package_name}.tar.gz"

	if command -v curl >/dev/null 2>&1; then
		downloader="curl"
	elif command -v wget >/dev/null 2>&1; then
		downloader="wget"
	else
		fail "Neither curl nor wget is available. Install one of them and try again."
	fi

	if [ -z "$version" ]; then
		info "Resolving the newest Hunk release..."
		# Parsed with sed rather than jq so the installer needs nothing but a shell and a downloader.
		version="$(fetch "$RELEASES_API" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)"
		[ -n "$version" ] || fail "Could not resolve the newest Hunk release from ${RELEASES_API}."
	fi

	home_dir="${HOME:-}"
	[ -n "$home_dir" ] || fail "HOME is not set, so there is nowhere to install Hunk."

	custom_dir=""
	if [ -n "${HUNK_INSTALL_DIR:-}" ]; then
		bin_dir="$HUNK_INSTALL_DIR"
		# The bundled skills are found by walking up from the binary, so a chosen directory holds
		# both. `hunk update` cannot recognize a custom directory once this shell exits, so the
		# install finishes with re-run guidance instead (see the note printed at the end).
		payload_dir="$HUNK_INSTALL_DIR"
		custom_dir="$HUNK_INSTALL_DIR"
	else
		payload_dir="${home_dir}/.hunk"
		bin_dir="${payload_dir}/bin"
	fi

	target_binary="${bin_dir}/hunk"

	current="$(installed_version "$target_binary")"
	if [ -z "$current" ] && command -v hunk >/dev/null 2>&1; then
		current="$(installed_version "$(command -v hunk)")"
	fi

	if [ "$current" = "$version" ]; then
		info "hunk ${version} is already installed."
		exit 0
	fi

	temp_dir="$(mktemp -d)"
	cleanup() {
		rm -rf "$temp_dir"
	}
	# INT/TERM exit explicitly so the shell cannot resume mid-install; EXIT then runs cleanup.
	trap cleanup EXIT
	trap 'exit 1' INT TERM

	archive_url="${DOWNLOAD_BASE}/v${version}/${archive_name}"
	info "Downloading ${archive_name} (v${version})..."
	download "$archive_url" "${temp_dir}/${archive_name}" ||
		fail "Could not download ${archive_url}. Check that the version exists and that this platform is published."

	# Checksums ship as one SHA256SUMS asset covering every archive in the release. Releases made
	# before that asset existed still install, with a warning rather than a silent skip.
	if download "${DOWNLOAD_BASE}/v${version}/SHA256SUMS" "${temp_dir}/SHA256SUMS" 2>/dev/null; then
		if command -v sha256sum >/dev/null 2>&1; then
			checksum_tool="sha256sum"
		elif command -v shasum >/dev/null 2>&1; then
			checksum_tool="shasum -a 256"
		else
			checksum_tool=""
		fi

		if [ -n "$checksum_tool" ]; then
			grep " \{1,2\}${archive_name}\$" "${temp_dir}/SHA256SUMS" >"${temp_dir}/SHA256SUMS.one" ||
				fail "SHA256SUMS has no entry for ${archive_name}. Refusing to install an unverified archive."
			info "Verifying checksum..."
			(cd "$temp_dir" && $checksum_tool -c SHA256SUMS.one >/dev/null) ||
				fail "Checksum verification failed for ${archive_name}. Refusing to install a corrupted or tampered archive."
		else
			warn "Neither sha256sum nor shasum is available, so the archive checksum was not verified."
		fi
	else
		warn "This release publishes no SHA256SUMS asset, so the archive checksum was not verified."
	fi

	info "Installing to ${bin_dir}..."
	mkdir -p "${temp_dir}/extract"
	# The archive holds one top-level `hunkdiff-<os>-<arch>/` directory with the binary, the bundled
	# skills, and metadata.json inside it; stripping that wrapper puts the payload at the root.
	tar -xzf "${temp_dir}/${archive_name}" -C "${temp_dir}/extract" --strip-components=1
	[ -f "${temp_dir}/extract/hunk" ] || fail "The downloaded archive contains no hunk binary."
	chmod 0755 "${temp_dir}/extract/hunk"

	mkdir -p "$payload_dir" "$bin_dir"
	# Swap the skills through renames — new tree in beside the old, old tree moved aside, then
	# removed — so no window exists where an existing install has no skills at all. The binary
	# moves last, through a same-directory rename, so a Hunk that is running right now is never
	# left pointing at a half-written tree.
	rm -rf "${payload_dir}/skills.new" "${payload_dir}/skills.old"
	mv "${temp_dir}/extract/skills" "${payload_dir}/skills.new"
	if [ -e "${payload_dir}/skills" ]; then
		mv "${payload_dir}/skills" "${payload_dir}/skills.old"
	fi
	mv "${payload_dir}/skills.new" "${payload_dir}/skills"
	rm -rf "${payload_dir}/skills.old"
	if [ -f "${temp_dir}/extract/metadata.json" ]; then
		mv -f "${temp_dir}/extract/metadata.json" "${payload_dir}/metadata.json"
	fi
	mv -f "${temp_dir}/extract/hunk" "${bin_dir}/hunk.new"
	mv -f "${bin_dir}/hunk.new" "$target_binary"
	chmod 0755 "$target_binary"

	info "Installed hunk ${version} to ${target_binary}"

	path_line="export PATH=\"${bin_dir}:\$PATH\""

	if [ "$no_modify_path" = "1" ]; then
		info "Left shell startup files untouched (--no-modify-path)."
		info "Add ${bin_dir} to your PATH to run hunk from anywhere."
	elif [ -n "${GITHUB_PATH:-}" ]; then
		# GitHub Actions reads this file between steps, so no shell startup file is involved.
		printf '%s\n' "$bin_dir" >>"$GITHUB_PATH"
		info "Added ${bin_dir} to \$GITHUB_PATH for later workflow steps."
	else
		shell_name="$(basename "${SHELL:-sh}")"
		case "$shell_name" in
		zsh)
			add_path_line "${ZDOTDIR:-$home_dir}/.zshrc" "$path_line"
			;;
		bash)
			add_path_line \
				"$(first_existing "${home_dir}/.bashrc" "${home_dir}/.bash_profile" "${home_dir}/.profile")" \
				"$path_line"
			;;
		fish)
			add_path_line "${home_dir}/.config/fish/config.fish" "fish_add_path \"${bin_dir}\""
			;;
		*)
			add_path_line "${home_dir}/.profile" "$path_line"
			;;
		esac
		info "Restart your shell, or run: export PATH=\"${bin_dir}:\$PATH\""
	fi

	info ""
	if [ -n "$custom_dir" ]; then
		info "Note: hunk update cannot auto-detect this custom install directory. To update later,"
		info "re-run this installer with HUNK_INSTALL_DIR=${custom_dir}."
		info "Run 'hunk --help' to get started."
	else
		info "Run 'hunk --help' to get started, and 'hunk update' to move to a newer release."
	fi
}

main "$@"
