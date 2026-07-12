{
  description = "Dev Flake for Modem-dev's Hunk";
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nixpkgs-lib.follows = "nixpkgs";
    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs-lib";
    };
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  nixConfig = {
    extra-substituters = [
      "https://nix-community.cachix.org"
    ];
    extra-trusted-public-keys = [
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
    ];
  };

  outputs =
    { flake-parts, bun2nix, ... }@inputs:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      perSystem =
        { system, pkgs, ... }:
        let
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
        in
        {
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
            default = pkgs.callPackage ./nix/devShell.nix { };
          };
        };

      flake = {
        homeManagerModules = {
          hunk = import ./nix/home-manager.nix;
          default = { pkgs, lib, ... }: {
            imports = [ inputs.self.homeManagerModules.hunk ];
            programs.hunk.package =
              lib.mkDefault
                inputs.self.packages.${pkgs.stdenv.hostPlatform.system}.default;
          };
        };
      };
    };
}
