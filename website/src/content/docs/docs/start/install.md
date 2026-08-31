---
title: Install
description: Install Hunk with the install script, npm, Homebrew, mise, or Nix and verify the CLI.
---

Hunk runs on macOS, Linux, and Windows. The install script is the default method on macOS and Linux; npm or mise covers Windows. npm installs require Node.js 22 or newer, while the install script, Homebrew, mise, and Nix installs are self-contained binaries that do not require Node.js. Git is recommended for the most common review workflows.

## Install script (default)

On macOS and Linux, the default install script downloads the prebuilt binary for your machine:

```bash
curl -fsSL https://hunk.dev/install.sh | sh
hunk --version
```

When the release publishes `SHA256SUMS` and your machine has `sha256sum` or `shasum`, the script verifies the downloaded archive before installing. Otherwise it warns that verification was skipped and continues. It installs into `~/.hunk` (binary at `~/.hunk/bin/hunk`, bundled agent skills beside it) and adds `~/.hunk/bin` to `PATH` in your shell's startup file. Restart your shell afterwards.

The script accepts these settings:

| Setting                                            | Effect                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `HUNK_VERSION`                                     | Install an exact release instead of the newest one. Also accepted as a positional argument. |
| `HUNK_INSTALL_DIR`                                 | Install the binary into this directory instead of `~/.hunk/bin`.                            |
| `--no-modify-path` (or `HUNK_NO_MODIFY_PATH=1`)    | Leave shell startup files alone.                                                            |
| `--force` (or `HUNK_ALLOW_CONFLICTING_INSTALLS=1`) | Install despite another Hunk on PATH or in a known version-manager directory.               |

By default, the installer refuses to create a second Hunk installation. It lists every competing
path it finds, its version and PATH precedence, and the command that removes it. Remove those
installs first; use `--force` only when you deliberately manage multiple copies.

```bash
curl -fsSL https://hunk.dev/install.sh | sh -s -- 0.19.0
curl -fsSL https://hunk.dev/install.sh | sh -s -- --no-modify-path
curl -fsSL https://hunk.dev/install.sh | sh -s -- --force
curl -fsSL https://hunk.dev/install.sh | HUNK_VERSION=0.19.0 sh
```

On Hunk 0.20 and newer, `hunk update` refreshes a default install in place. An install redirected with `HUNK_INSTALL_DIR` cannot be auto-detected later (the variable is gone once your shell exits), so update one of those by re-running the script with the same `HUNK_INSTALL_DIR`; the installer prints a reminder at the end of a custom-directory install.

Windows is not covered by the script; use npm or mise there.

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

Starting with Hunk 0.20, `hunk update` is the canonical way to move npm, Homebrew, and default install-script installs to the newest release. It uses the package manager that installed Hunk:

```bash
hunk update          # install the newest release
hunk update --check  # check without installing
hunk update 0.20.0   # install an exact npm or default install-script release
```

On an older Hunk release, update once with the installer or package manager that installed it; after that, use `hunk update`. npm installs (including `bun` and `pnpm` global installs), Homebrew installs, and default install-script installs update in place; an install-script update re-runs the installer with the target version and the same conditional checksum verification described above. mise, Nix, and local source builds remain owned by their own tooling, so use `mise up hunk`, your Nix configuration, or `bun run install:bin` instead. A custom `HUNK_INSTALL_DIR` also requires re-running the installer with the same directory, as described above. Pass `--method npm`, `--method brew`, or `--method curl` if Hunk detects the wrong method.

Next, [review your first working tree](/docs/start/quick-start/).
