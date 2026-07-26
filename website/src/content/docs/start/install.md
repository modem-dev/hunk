---
title: Install
description: Install Hunk with npm, Homebrew, or Nix and verify the CLI.
---

Hunk requires Node.js 18 or newer and runs on macOS, Linux, and Windows. Git is recommended for the most common review workflows.

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
