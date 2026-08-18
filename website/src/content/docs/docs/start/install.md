---
title: Install
description: Install Hunk with the install script, npm, Homebrew, mise, or Nix and verify the CLI.
---

Hunk runs on macOS, Linux, and Windows. npm installs require Node.js 18 or newer; the install script, Homebrew, mise, and Nix installs are self-contained binaries. Git is recommended for the most common review workflows.

## Install script

On macOS and Linux, the install script downloads the prebuilt binary for your machine:

```bash
curl -fsSL https://hunk.dev/install.sh | sh
hunk --version
```

It verifies the downloaded archive against the release's published `SHA256SUMS`, installs into `~/.hunk` (binary at `~/.hunk/bin/hunk`, bundled agent skills beside it), and adds `~/.hunk/bin` to `PATH` in your shell's startup file. Restart your shell afterwards.

The script reads three settings:

| Setting                                         | Effect                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `HUNK_VERSION`                                  | Install an exact release instead of the newest one. Also accepted as a positional argument. |
| `HUNK_INSTALL_DIR`                              | Install the binary into this directory instead of `~/.hunk/bin`.                            |
| `--no-modify-path` (or `HUNK_NO_MODIFY_PATH=1`) | Leave shell startup files alone.                                                            |

```bash
curl -fsSL https://hunk.dev/install.sh | sh -s -- 0.19.0
curl -fsSL https://hunk.dev/install.sh | sh -s -- --no-modify-path
curl -fsSL https://hunk.dev/install.sh | HUNK_VERSION=0.19.0 sh
```

`hunk update` refreshes a default install in place. An install redirected with `HUNK_INSTALL_DIR` cannot be auto-detected later (the variable is gone once your shell exits), so update one of those by re-running the script with the same `HUNK_INSTALL_DIR`; the installer prints a reminder at the end of a custom-directory install.

Windows is not covered by the script; use npm there.

## npm

Install the published `hunkdiff` package globally:

```bash
npm install --global hunkdiff
hunk --version
```

The package exposes both `hunk` and `hunkdiff`; the docs use `hunk`.

## Homebrew

```bash
brew install hunk
hunk --version
```

If you previously used the old `modem-dev/tap` formula, remove it before installing from Homebrew core:

```bash
brew uninstall modem-dev/tap/hunk
brew install hunk
```

## mise

[mise](https://mise.jdx.dev) knows Hunk by the short name `hunk` (alias `hunkdiff`) and installs the prebuilt binary on macOS, Linux, and Windows:

```bash
mise use -g hunk
hunk --version
```

On Windows, use mise 2026.8.6 or newer; earlier releases fail with `unsupported env: windows/amd64`.

Hunk also ships as a default tool in [Omarchy](https://omarchy.org), which installs it through mise.

## Nix

The repository exports a `default` package from `flake.nix`. From a clone of Hunk:

```bash
nix build
./result/bin/hunk --version
```

See the repository's `nix/README.md` for Home Manager and development-shell details.

## Verify the install

```bash
hunk --help
```

You should see `Usage: hunk <command> [options]`. If the shell cannot find Hunk, ensure your global npm, Homebrew, mise, or `~/.hunk/bin` directory is on `PATH`, then open a new shell.

## Update Hunk

`hunk update` replaces Hunk with the newest release, using the package manager that installed it:

```bash
hunk update          # install the newest release
hunk update --check  # report the installed and available versions
hunk update 0.19.0   # install a specific npm release
```

npm installs (including `bun` and `pnpm` global installs), Homebrew installs, and install-script installs update in place; a curl install re-runs the install script with the target version. mise, Nix, and local source builds are owned by their own tooling, so Hunk prints the command that updates them — `mise up hunk`, your Nix configuration, or `bun run install:bin` — instead of updating itself. Pass `--method npm`, `--method brew`, or `--method curl` if Hunk detects the wrong one.

Next, [review your first working tree](/docs/start/quick-start/).
