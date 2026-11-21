# Swaps the Nix dev shell's Node and Bun for the first releases that distrust the
# compromised eMudhra (emSign) intermediates.
#
# TEMPORARY eMudhra workaround. Node and Bun carry their own root stores, so
# system trust-store fixes (such as nix-darwin's
# `security.pki.caCertificateBlacklist`) do not reach them; the first upstream
# releases whose stores reject the compromised chain are
#   node 24.22.1 (NSS 3.131.1 roots + blocked-SPKI check, 2026-10-20)
#   bun   1.4.4  (roots updated to NSS 3.131.1, 2026-10-22)
# while the flake's nixpkgs pin still carries older builds. Bun is replaced on
# every supported system. Node is replaced on macOS only, where the prebuilt
# nodejs.org tarball in nodejs-bin.nix applies; Linux shells keep nixpkgs' node.
#
# Invariants:
# - Self-retiring: each replacement applies only while the pinned nixpkgs version
#   is older than the fixed release, so `nix flake update` turns it off on its own.
# - The attribute *names* this overlay defines never depend on `prev`; the gates
#   live in the values. Conditional names would recurse through the fixpoint.
# - Version gates read `prev.nodejs-slim_24`, not `prev.nodejs_24`: at this
#   nixpkgs `nodejs_24` is a symlinkJoin whose `version` resolves through `final`,
#   which would recurse back into this overlay.
#
# Remove when nixpkgs' `nodejs_24` is >= 24.22.1 and `bun` is >= 1.4.4: delete
# this file, `nix/nodejs-bin.nix`, and the `overlays` line in `flake.nix`.
# Check with:
#   curl -s https://raw.githubusercontent.com/NixOS/nixpkgs/nixpkgs-unstable/pkgs/development/web/nodejs/v24.nix | grep version
#   curl -s https://raw.githubusercontent.com/NixOS/nixpkgs/nixpkgs-unstable/pkgs/by-name/bu/bun/package.nix | grep version
final: prev:
let
  inherit (prev.stdenv.hostPlatform) system isDarwin;
  wantNode = prev.lib.versionOlder (prev.nodejs-slim_24 or prev.nodejs_24).version "24.22.1";
  wantBun = prev.lib.versionOlder prev.bun.version "1.4.4";

  # Official nodejs.org tarball; see the header of nodejs-bin.nix.
  nodejsBin = import ./nodejs-bin.nix { pkgs = prev; };

  # nixpkgs' bun is already "unzip the official GitHub release asset", so only
  # version and src move; the autoPatchelf (Linux) and install_name_tool/codesign
  # (macOS) hooks and completions are reused as-is. Each system takes the same
  # asset flavor nixpkgs selects for it. Hashes come from SHASUMS256.txt on the
  # bun-v1.4.4 release.
  bunVersion = "1.4.4";
  bunSrc = {
    "aarch64-darwin" = prev.fetchurl {
      url = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-darwin-aarch64.zip";
      hash = "sha256-wkDX8My5DCY6hJ/NsJt+5iYw2SE0jtaq/ahrnVd7xRA=";
    };
    "x86_64-darwin" = prev.fetchurl {
      url = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-darwin-x64-baseline.zip";
      hash = "sha256-1KFVrfv9CRVes7oFyeOlRPOSl9emhhbTx3WfZ6tcR9w=";
    };
    "aarch64-linux" = prev.fetchurl {
      url = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-linux-aarch64.zip";
      hash = "sha256-uqa7NvUdblhWHgK76oJQOKnfRU9nPW13bou/hvjHhQ4=";
    };
    "x86_64-linux" = prev.fetchurl {
      url = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-linux-x64.zip";
      hash = "sha256-v4zL+ysLgBWeD5ptFcVTF63YB3U028YTCj7bUvzLOVw=";
    };
  };
  bunBin = prev.bun.overrideAttrs (_: {
    version = bunVersion;
    src = bunSrc.${system} or (throw "emudhra-overlay.nix: no bun ${bunVersion} hash for ${system}");
  });

  # Gates are evaluated lazily inside each value, so a system that keeps its
  # nixpkgs package never forces the replacement derivation.
  pick = want: replacement: orig: if want then replacement else orig;
  wantNodeHere = isDarwin && wantNode;
in
{
  nodejs = pick wantNodeHere nodejsBin prev.nodejs;
  nodejs_24 = pick wantNodeHere nodejsBin prev.nodejs_24;
  nodejs-slim = pick wantNodeHere nodejsBin prev.nodejs-slim;
  nodejs-slim_24 = pick wantNodeHere nodejsBin prev.nodejs-slim_24;
  bun = pick wantBun bunBin prev.bun;
}
