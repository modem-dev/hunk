{pkgs}: let
  packageData = builtins.fromJSON (builtins.readFile ../package.json);

  # Fetch dependencies (Network enabled, verified by hash)
  bunDeps = pkgs.stdenv.mkDerivation {
    pname = "hunk-deps";
    inherit (packageData) version;
    src = ../.;
    dontCheckForBrokenSymlinks = true;
    nativeBuildInputs = [pkgs.bun];
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
    outputHash = pkgs.lib.fileContents ./nix-deps-hash.txt;

    buildPhase = ''
      export HOME=$TMPDIR
      bun install --frozen-lockfile --no-progress --ignore-scripts
    '';

    installPhase = ''
      mkdir -p $out
      cp -R node_modules $out/
    '';
  };
in
  pkgs.stdenv.mkDerivation {
    pname = "hunk";
    inherit (packageData) version;
    src = ../.;
    dontStrip = true;

    nativeBuildInputs = with pkgs; [
      bun
      bash
    ];

    buildPhase = ''
      runHook preBuild

      # Copy the pre-fetched dependencies
      cp -R ${bunDeps}/node_modules ./node_modules
      chmod -R +w ./node_modules

      # Use project's custom build script
      bun run build:bin

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out/bin
      cp ./dist/hunk $out/bin/hunk
      chmod +x $out/bin/hunk
      runHook postInstall
    '';

    meta = with pkgs.lib; {
      description = "Terminal diff viewer for agentic changesets";
      homepage = "https://github.com/modem-dev/hunk";
      license = licenses.mit;
      mainProgram = "hunk";
      platforms = platforms.all;
    };
  }
