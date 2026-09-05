{
  bun,
  bun2nix,
  lib,
  makeWrapper,
  stdenv,
  ...
}: let
  packageJson = lib.importJSON ../packages/hunk/package.json;
  # Match scripts/build-bin.ts: Bun's default x64 runtime requires AVX2/BMI2,
  # while the baseline variants support the x86-64-v2 machines Hunk targets.
  compileTarget =
    if !stdenv.hostPlatform.isx86_64
    then null
    else if stdenv.hostPlatform.isDarwin
    then "bun-darwin-x64-baseline"
    else if stdenv.hostPlatform.isLinux
    then
      if stdenv.hostPlatform.isMusl
      then "bun-linux-x64-musl-baseline"
      else "bun-linux-x64-baseline"
    else null;
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
      mkdir -p .bun-tmp .bun-install
      BUN_TMPDIR=$PWD/.bun-tmp \
      BUN_INSTALL=$PWD/.bun-install \
      ${bun}/bin/bun build --compile \
        --no-compile-autoload-bunfig \
        ${lib.optionalString (compileTarget != null) "--target=${compileTarget}"} \
        "./packages/hunk/src/main.tsx" \
        "./packages/hunk/src/highlightWorkerEntry.ts" \
        --outfile "hunk-bin"
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out/bin
      cp -p ./hunk-bin $out/bin/hunk
      cp -r ./packages/hunk/skills $out/
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
