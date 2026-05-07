{
  description = "Hunk - Review-first terminal diff viewer for agentic coders";
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    systems.url = "github:nix-systems/default";
  };

  outputs = {
    systems,
    nixpkgs,
    ...
  }: let
    eachSystem = nixpkgs.lib.genAttrs (import systems);
  in {
    packages = eachSystem (
      system: let
        pkgs = import nixpkgs {inherit system;};
      in {
        default = import ./.nix/package.nix {inherit pkgs;};
      }
    );
    devShells = eachSystem (
      system: let
        pkgs = import nixpkgs {inherit system;};
      in {
        default = pkgs.mkShell {
          buildInputs = with pkgs; [
            bun
            nodejs
          ];
        };
      }
    );
  };
}
