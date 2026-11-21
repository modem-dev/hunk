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
      tab_width = 4;
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

## Supported systems

The flake builds for `x86_64-linux`, `aarch64-linux`, and `aarch64-darwin`.

Intel macOS (`x86_64-darwin`) is not exposed, because Nixpkgs 26.11 dropped support for it and merely _declaring_ a dropped system breaks flake evaluation for everyone consuming Hunk. Intel macOS users should install Hunk via npm or Homebrew instead.

If you pin an older Nixpkgs that still supports a system Hunk does not list, point Hunk's `systems` input at a wider list:

```nix
{
  inputs.hunk = {
    url = "github:modem-dev/hunk";
    inputs.nixpkgs.follows = "nixpkgs";
    inputs.systems.url = "github:nix-systems/default"; # adds x86_64-darwin
  };
}
```

The same input also drives bun2nix, so overriding it once widens the whole build. If your flake already has its own `systems` input, `inputs.systems.follows = "systems"` works too.

## Building using Nix

Run `nix build` to build the default package for the current system. The resulting Hunk binary will be `./result/bin/hunk`.

You can also build the named package explicitly:

```bash
nix build .#hunk
```

The package compiles Hunk with `scripts/build/build-bin.ts`, the same script that produces the npm and GitHub release binaries, so the Nix binary carries the same entrypoints and runtime policy. On x86_64 that script targets Bun's `-baseline` runtime (no AVX2 requirement); `nix/package.nix` fetches that flavor of the pinned Bun release and passes it as `--runtime-executable` so the sandboxed build never downloads a runtime. When bumping `packageManager`, update every archive hash in `nix/package.nix`.

## Maintainer dependency updates

When JavaScript or Bun dependencies change, regenerate the Nix dependency lockfile and commit it with the dependency change:

```bash
bun run nix:update-lock
```

This script requires Nix and runs the flake-pinned `bun2nix` version from `flake.lock`.
