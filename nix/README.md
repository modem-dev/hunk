# Installing using Nix

Nix users can install Hunk from source instead of using npm.

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

2. Use in NixOS `environment.systemPackages` or `home.packages`:

```nix
{
    packages = [
        inputs.hunk.packages.${pkgs.stdenv.hostPlatform.system}.default
    ]
}
```

## Building using Nix

Simply run `nix build .#packages.{YOUR_SYSTEM}.default` where YOUR_SYSTEM is one of `x86_64-linux`, `x86_64-darwin`, `aarch64-linux` or `aarch64-darwin`. The resulting
Hunk binary will be `./result/bin/hunk`.
