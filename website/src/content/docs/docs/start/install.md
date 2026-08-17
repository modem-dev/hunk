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

You should see `Usage: hunk <command> [options]`. If the shell cannot find Hunk, ensure your global npm, Homebrew, or mise binary directory is on `PATH`, then open a new shell.

## Update Hunk

`hunk update` replaces Hunk with the newest release, using the package manager that installed it:

```bash
hunk update          # install the newest release
hunk update --check  # report the installed and available versions
hunk update 0.19.0   # install a specific npm release
```

npm installs (including `bun` and `pnpm` global installs) and Homebrew installs update in place. mise, Nix, and local source builds are owned by their own tooling, so Hunk prints the command that updates them — `mise up hunk`, your Nix configuration, or `bun run install:bin` — instead of updating itself. Pass `--method npm` or `--method brew` if Hunk detects the wrong one.

Next, [review your first working tree](/docs/start/quick-start/).
