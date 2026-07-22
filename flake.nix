{
  description = "Dev Flake for Modem-dev's Hunk";
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    bun2nix.url = "github:nix-community/bun2nix";
    bun2nix.inputs.nixpkgs.follows = "nixpkgs";
    # nixpkgs-unstable has dropped x86_64-darwin and now hard-errors when
    # instantiated for it. bun2nix's default systems list (nix-systems/default)
    # still includes x86_64-darwin, which breaks any downstream evaluation that
    # touches bun2nix's per-system outputs. The vendored list in ./nix/systems
    # is nix-systems/default minus x86_64-darwin.
    systems.url = "path:./nix/systems";
    bun2nix.inputs.systems.follows = "systems";
  };
  nixConfig = {
    extra-substituters = [
      "https://nix-community.cachix.org"
    ];
    extra-trusted-public-keys = [
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
    ];
  };
  outputs = {
    self,
    nixpkgs,
    bun2nix,
    ...
  }: let
    lib = nixpkgs.lib;
    supportedSystems = [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ];
    forAllSystems = lib.genAttrs supportedSystems;
    perSystem = forAllSystems (
      system: let
        pkgs = import nixpkgs {
          inherit system;
        };
        hunk = pkgs.callPackage ./nix/package.nix {
          bun2nix = bun2nix.packages.${system}.default;
        };
        updateBunLock = pkgs.writeShellScriptBin "hunk-update-bun-lock" ''
          set -euo pipefail
          ${bun2nix.packages.${system}.default}/bin/bun2nix -o nix/bun.lock.nix -c ../ "$@"
          if [ -s nix/bun.lock.nix ] && [ "$(${pkgs.coreutils}/bin/tail -c 1 nix/bun.lock.nix)" != "" ]; then
            printf '\n' >> nix/bun.lock.nix
          fi
        '';
      in {
        packages = {
          inherit hunk;
          default = hunk;
        };
        apps = {
          default = {
            type = "app";
            program = "${hunk}/bin/hunk";
            meta.description = "Run Hunk";
          };
          update-bun-lock = {
            type = "app";
            program = "${updateBunLock}/bin/hunk-update-bun-lock";
            meta.description = "Regenerate nix/bun.lock.nix with the flake-pinned bun2nix";
          };
        };
        devShells = {
          default = pkgs.callPackage ./nix/devShell.nix {};
        };
      }
    );
    systemOutput = name: lib.mapAttrs (_: value: value.${name}) perSystem;
  in {
    packages = systemOutput "packages";
    apps = systemOutput "apps";
    devShells = systemOutput "devShells";

    homeManagerModules = {
      hunk = import ./nix/home-manager.nix;
      default = {pkgs, ...}: {
        imports = [self.homeManagerModules.hunk];
        programs.hunk.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      };
    };
  };
}
