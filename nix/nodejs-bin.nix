# Packages the official prebuilt Node.js tarball from nodejs.org for macOS.
#
# TEMPORARY eMudhra workaround, darwin-only. Node ships its own root store, so the
# nix-darwin `security.pki.caCertificateBlacklist` fix does not reach it. Node
# 24.22.1 (2026-10-20) is the first release whose root store (NSS 3.131.1 plus the
# blocked-SPKI check) rejects the compromised eMudhra intermediates; the flake's
# nixpkgs pin still carries 24.14.1. `nix/emudhra-overlay.nix` substitutes this
# derivation for `nodejs`/`nodejs_24` only while that pin is older than 24.22.1,
# so the file retires itself once `nix flake update` catches up.
#
# Remove it once nixpkgs' `nodejs_24` is >= 24.22.1 (24.22.1 merged into nixpkgs
# `staging` on 2026-10-21, NixOS/nixpkgs#576777): delete this file,
# `nix/emudhra-overlay.nix`, and the `overlays` line in `flake.nix`. Check with:
#   curl -s https://raw.githubusercontent.com/NixOS/nixpkgs/nixpkgs-unstable/pkgs/development/web/nodejs/v24.nix | grep version
#
# Bumping: change `version`, then copy the darwin sha256 lines from
# https://nodejs.org/dist/v<version>/SHASUMS256.txt
{ pkgs }:
let
  version = "24.22.1";
  inherit (pkgs.stdenv.hostPlatform) system;
  arch =
    {
      "aarch64-darwin" = "arm64";
      "x86_64-darwin" = "x64";
    }
    .${system} or (throw "nodejs-bin.nix: no prebuilt Node.js tarball mapping for ${system}");
  sha256 =
    {
      "aarch64-darwin" = "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7";
      "x86_64-darwin" = "d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035";
    }
    .${system};
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "nodejs-bin";
  inherit version;

  src = pkgs.fetchurl {
    url = "https://nodejs.org/dist/v${version}/node-v${version}-darwin-${arch}.tar.gz";
    inherit sha256;
  };

  dontConfigure = true;
  dontBuild = true;
  # Prebuilt Mach-O binaries; nothing to strip or fix up.
  dontStrip = true;
  dontFixup = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -R bin include lib share $out/
    # npm/npx/corepack ship with `#!/usr/bin/env node`; pin them to this node so
    # they work regardless of what else is on PATH.
    export PATH=$out/bin:$PATH
    patchShebangs $out/lib/node_modules/npm/bin $out/lib/node_modules/corepack/dist
    runHook postInstall
  '';

  passthru = {
    # Mirror the attributes nixpkgs' nodejs exposes that callers commonly read.
    inherit version;
    python = pkgs.python3;
  };

  meta = with pkgs.lib; {
    description = "Node.js ${version} (official prebuilt binary)";
    homepage = "https://nodejs.org";
    license = licenses.mit;
    sourceProvenance = [ sourceTypes.binaryNativeCode ];
    platforms = [
      "aarch64-darwin"
      "x86_64-darwin"
    ];
    mainProgram = "node";
  };
}
