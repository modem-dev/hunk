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
  bunCompilerArchives = {
    "aarch64-darwin" = fetchurl {
      url = "https://registry.npmjs.org/@oven/bun-darwin-aarch64/-/bun-darwin-aarch64-${bunVersion}.tgz";
      hash = "sha512-MXdZkP1featqxZ+/VTXWG1BVjM4OGBehVY2Q88EeUj/7L0UMeCGItmyPYTN+wxvlGJ6F66JEtzsw+GvQWewnag==";
    };
    "x86_64-darwin" = fetchurl {
      url = "https://registry.npmjs.org/@oven/bun-darwin-x64/-/bun-darwin-x64-${bunVersion}.tgz";
      hash = "sha512-gZTxZuLjkUhAWjTETu3tw0WhsEdNkJ64daj60ybhPf835a2yollV3yTkK9JozvzKPx4TRFzLSl8C+U525pxVbw==";
    };
    "aarch64-linux" = fetchurl {
      url = "https://registry.npmjs.org/@oven/bun-linux-aarch64/-/bun-linux-aarch64-${bunVersion}.tgz";
      hash = "sha512-3BBP9ovJ2RGHFH6Ae1CAtxNtG1+YY6GD6rmYbsUosoAk9+OEl6zeDQ/k4fBkc6dYOJCtWnx8hUxzNzQATSmvYQ==";
    };
    "x86_64-linux" = fetchurl {
      url = "https://registry.npmjs.org/@oven/bun-linux-x64/-/bun-linux-x64-${bunVersion}.tgz";
      hash = "sha512-9/E/UXOTpSo3YsV5g+FhtTd/qTpiWoKuxS12cqtuYA1ssu9fRAoPQnipFgGyck3tWO63iUdxBiygq+kELFawng==";
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
    nativeBuildInputs = lib.optionals stdenv.isLinux [autoPatchelfHook];
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
      mkdir -p .bun-tmp .bun-install

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

      BUN_TMPDIR=$PWD/.bun-tmp \
      BUN_INSTALL=$PWD/.bun-install \
      "$bun_compiler" build --compile \
        --no-compile-autoload-bunfig \
        "./packages/hunk/src/main.tsx" \
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
