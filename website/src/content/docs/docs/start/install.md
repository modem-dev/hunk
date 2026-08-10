---
title: Install
description: Install Hunk with npm, Homebrew, mise, or Nix and verify the CLI.
---

Hunk runs on macOS, Linux, and Windows. npm installs require Node.js 18 or newer; Homebrew, mise, and Nix installs are self-contained binaries. Git is recommended for the most common review workflows.

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

Hunk is registered in the [mise](https://mise.jdx.dev) registry under the short name `hunk`, backed by the prebuilt binaries attached to GitHub releases:

```bash
mise use -g hunk
hunk --version
```

Pin a version per project with `mise use hunk@<version>`, or reference the backend directly with `mise use -g aqua:modem-dev/hunk`. Prebuilt binaries cover macOS and Linux; on Windows, install with npm instead.

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

You should see `Usage: hunk <command> [options]`. If the shell cannot find Hunk, ensure your global npm or Homebrew binary directory is on `PATH`, then open a new shell.

Next, [review your first working tree](/docs/start/quick-start/).
