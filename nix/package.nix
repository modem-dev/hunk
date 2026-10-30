{
  autoPatchelfHook,
  bun2nix,
  fetchurl,
  lib,
  makeWrapper,
  stdenv,
  ...
}: let
  packageJson = lib.importJSON ../packages/hunk/package.json;
  bunVersion = lib.removePrefix "bun@" packageJson.packageManager;
  # The Bun that compiles Hunk is also the runtime embedded in the result, so each archive must
  # be the flavor `compileTargetForHost` in scripts/build/build-bin.ts picks for that system:
  # x64 uses Bun's `-baseline` build (x86-64-v2, no AVX2) so the binary runs on older CPUs and
  # conservative VMs, matching the published npm and GitHub release binaries. arm64 has no such
  # split. Update every hash together when `packageManager` changes.
  bunCompilerArchives = {
    "aarch64-darwin" = fetchurl {
      url = "https://registry.npmjs.org/@oven/bun-darwin-aarch64/-/bun-darwin-aarch64-${bunVersion}.tgz";
      hash = "sha512-zW/hxwc8sJAILGwB5eTC4i48ouGXf0V4lrxmEOk3JIE6JkYVW1TZh1E2pIempqsezgW1sckTIIDudFON8bJ2Mw==";
    };
    "x86_64-darwin" = fetchurl {
      url = "https://registry.npmjs.org/@oven/bun-darwin-x64-baseline/-/bun-darwin-x64-baseline-${bunVersion}.tgz";
      hash = "sha512-uzSXckTnNNS7Un1ihiM31R7P5iKndZ65t6Zj3iI72SrfoV2uI97MKM8z1qer2oRHyqXHLUIJTIhj+qT5UeEjrw==";
    };
    "aarch64-linux" = fetchurl {
      url = "https://registry.npmjs.org/@oven/bun-linux-aarch64/-/bun-linux-aarch64-${bunVersion}.tgz";
      hash = "sha512-ZTVtpf9zmHSBVPX1sBwe5agGb/rN34yPGg/Hby8e2Ax2uCUA2URZKlZH7qLntK7qaFJCMXh9v0GWNYN2zINz1w==";
    };
    "x86_64-linux" = fetchurl {
      url = "https://registry.npmjs.org/@oven/bun-linux-x64-baseline/-/bun-linux-x64-baseline-${bunVersion}.tgz";
      hash = "sha512-FBU6T21NT+i+rESbi0Z8A8G5xN51c+WZ0v6pIjI6szSzOlqVNv64nf7FPnwNIyxKD1M7Wg5cEobLC/QbzCeLtA==";
    };
  };
  bunCompilerArchive = bunCompilerArchives.${stdenv.hostPlatform.system};
  bunCompiler = stdenv.mkDerivation {
    pname = "bun-compiler";
    version = bunVersion;
    src = bunCompilerArchive;
    sourceRoot = "package";
    dontBuild = true;
    dontStrip = true;
    nativeBuildInputs = lib.optionals stdenv.hostPlatform.isLinux [autoPatchelfHook];
    installPhase = ''
      mkdir -p $out/bin
      cp -p bin/bun $out/bin/bun
    '';
  };
in
  bun2nix.mkDerivation {
    pname = "hunkdiff";
    version = packageJson.version;

    src = ../.;

    bunDeps = bun2nix.fetchBunDeps {
      bunNix = ./bun.lock.nix;
    };

    nativeBuildInputs = [makeWrapper];

    buildPhase = ''
      runHook preBuild

      # Compile with the pinned release archive instead of nixpkgs' older Bun.
      bun_compiler=${bunCompiler}/bin/bun
      if [ ! -x "$bun_compiler" ]; then
        echo "Bun compiler archive did not contain an executable" >&2
        exit 1
      fi
      if [ "$("$bun_compiler" --version)" != "${bunVersion}" ]; then
        echo "Expected Bun compiler ${bunVersion}" >&2
        exit 1
      fi

      # The same script produces the npm and GitHub release binaries. It targets Bun's
      # baseline runtime on x64, which Bun would otherwise download; hand it the archive
      # above as that runtime so the sandboxed build stays offline. Output lands in dist/.
      "$bun_compiler" run ./scripts/build/build-bin.ts --runtime-executable "$bun_compiler"
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out/bin
      cp -p ./dist/hunk $out/bin/hunk
      # `hunk patch` (and friends) respawn the TUI through a `hunkdiff`
      # lookup, mirroring the npm package's dual `hunk`/`hunkdiff` bins.
      # Without this alias the review flow fails with
      # "unable to execute '…/bin/hunkdiff'".
      ln -s hunk $out/bin/hunkdiff
      cp -r ./dist/skills $out/
      wrapProgram $out/bin/hunk --set HUNK_INSTALL_SOURCE nix
      runHook postInstall
    '';

    # See https://nix-community.github.io/bun2nix/building-packages/hook.html#arguments for options
    dontFixup = true;
    dontStrip = true;
    dontRunLifecycleScripts = true;

    meta = with lib; {
      description = "Terminal diff viewer for agentic changesets";
      homepage = "https://github.com/modem-dev/hunk";
      license = licenses.mit;
      mainProgram = "hunk";
      platforms = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
    };
  }
