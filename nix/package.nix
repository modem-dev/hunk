{
  bun,
  bun2nix,
  lib,
  ...
}: let
  packageJson = lib.importJSON ../package.json;
in
  bun2nix.mkDerivation {
    pname = "hunkdiff";
    version = packageJson.version;

    src = ../.;

    bunDeps = bun2nix.fetchBunDeps {
      bunNix = ./bun.lock.nix;
    };

    buildPhase = ''
      runHook preBuild
      mkdir -p .bun-tmp .bun-install
      BUN_TMPDIR=$PWD/.bun-tmp \
      BUN_INSTALL=$PWD/.bun-install \
      ${bun}/bin/bun build --compile \
        --no-compile-autoload-bunfig \
        "./src/main.tsx" \
        --outfile "hunk-bin"
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out/bin
      cp -p ./hunk-bin $out/bin/hunk
      cp -r ./skills $out/
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
