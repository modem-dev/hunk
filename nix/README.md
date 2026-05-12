# Installing using Nix

Nix users can install Hunk from source instead of using npm.

## Install from a flake

1. Add Hunk to your nix flake inputs like such:

```nix
{
    inputs = {
        hunk = {
          url = "github:modem-dev/hunk";
          inputs.nixpkgs.follows = "nixpkgs";
        };
    }
}
```

2. Use in NixOS `environment.systemPackages`:

```nix
{
  environment.systemPackages = [
    inputs.hunk.packages.${pkgs.stdenv.hostPlatform.system}.hunk
  ];
}
```

Or in Home Manager `home.packages`:

```nix
{
  home.packages = [
    inputs.hunk.packages.${pkgs.stdenv.hostPlatform.system}.hunk
  ];
}
```

## Home Manager

Hunk provides a Home Manager module to manage both the package and its configuration.

1. Add the module to your Home Manager configuration:

```nix
{
  imports = [
    inputs.hunk.homeManagerModules.default
  ];

  programs.hunk = {
    enable = true;
    enableGitIntegration = true; # Optional: set hunk as default git pager
    settings = {
      theme = "graphite";
      mode = "split";
      line_numbers = true;
    };
  };
}
```

`enableGitIntegration` writes to Home Manager's Git configuration, so it requires Home Manager's Git module to be enabled with `programs.git.enable = true;`.

## Running from a flake

Run Hunk directly with Nix:

```bash
nix run github:modem-dev/hunk -- --help
```

## Updating Hunk

Flake users update Hunk by updating their own pinned `flake.lock` input:

```bash
nix flake lock --update-input hunk
```

## Building using Nix

Run `nix build` to build the default package for the current system. The resulting Hunk binary will be `./result/bin/hunk`.

You can also build the named package explicitly:

```bash
nix build .#hunk
```

## Maintainer dependency updates

When JavaScript or Bun dependencies change, regenerate the Nix dependency lockfile and commit it with the dependency change:

```bash
bun run nix:update-lock
```

This script requires Nix and runs the flake-pinned `bun2nix` version from `flake.lock`.
