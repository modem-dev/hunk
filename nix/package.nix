{
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
      bun build --compile "./src/main.tsx" --outfile "hunk-bin"
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out/bin
      cp -p ./hunk-bin $out/bin/hunk
      runHook postInstall
    '';

    dontFixup = true;
    dontStrip = true;
  }
