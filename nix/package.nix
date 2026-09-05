{
  autoPatchelfHook,
  bun2nix,
  fetchurl,
  lib,
  makeWrapper,
  stdenv,
  ...
}: let
  packageJson = lib.importJSON ../package.json;
  bunVersion = lib.removePrefix "bun@" packageJson.packageManager;
  bunCompilerArchives = {
    "aarch64-darwin" = fetchurl {
      url = "https://registry.npmjs.org/@oven/bun-darwin-aarch64/-/bun-darwin-aarch64-${bunVersion}.tgz";
      hash = "sha512-XDvoYbH1rH3fpFYM/9U6y3nSk9KPTqeDvAcCfseSbfu2iXerF0pX7dh0lAwevi2VooHjc6MsyyWwmRiaN33s/A==";
    };
    "x86_64-darwin" = fetchurl {
      url = "https://registry.npmjs.org/@oven/bun-darwin-x64/-/bun-darwin-x64-${bunVersion}.tgz";
      hash = "sha512-i+eEXD6cUu7/pP3QGvfUlkOkY+J7O8XKggkSKS77yg++EUk1p1vqfG0loQXwHBIEycPYL9Tp7mKcixiARAT9nQ==";
    };
    "aarch64-linux" = fetchurl {
      url = "https://registry.npmjs.org/@oven/bun-linux-aarch64/-/bun-linux-aarch64-${bunVersion}.tgz";
      hash = "sha512-QLY/skFymGa6vv9xPhxWwGh4QQzXvPhA3ocFVXaoB1Lcepcwo9dZ5TyMmAXIW/I4XImUsppUVGml0dp6QqwO9Q==";
    };
    "x86_64-linux" = fetchurl {
      url = "https://registry.npmjs.org/@oven/bun-linux-x64/-/bun-linux-x64-${bunVersion}.tgz";
      hash = "sha512-ma2AO7f/0YZ1KLU7IHO0BFd41zryMbPA2hzgyIw5MWG64MVUvCfbKUc7+nQ+pLgJOIHuA9r075i0TWWlBGE+BA==";
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
        "./src/main.tsx" \
        --outfile "hunk-bin"
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out/bin
      cp -p ./hunk-bin $out/bin/hunk
      cp -r ./skills $out/
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
