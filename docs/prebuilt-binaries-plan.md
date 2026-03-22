# npm distribution plan: prebuilt platform binaries

Status: planned

## Context

`hunkdiff` currently publishes a small Node launcher that shells out to a bundled `bun` npm dependency. That solved the immediate install UX problem, but it still makes `npm i -g hunkdiff` slower than it needs to be because users install both:

- the Hunk package
- a full Bun runtime package

The better long-term shape is the pattern used by tools like `opencode-ai`:

- a tiny top-level npm package
- platform-specific packages in `optionalDependencies`
- a small launcher that resolves and execs the matching binary

## Findings from the opencode pattern

From the published npm packages:

- `opencode-ai` is a tiny meta package with a Node launcher in `bin/opencode`
- it declares many platform packages via `optionalDependencies`
- each platform package contains only a binary and a tiny `package.json`
- the launcher:
  - maps `process.platform` / `process.arch` to package names
  - handles Linux musl vs glibc
  - handles x64 baseline fallbacks
  - searches upward for `node_modules/<pkg>/bin/<binary>`
  - prints a manual install hint when npm fails to install the matching optional dependency

That is the right model for Hunk too.

## Goals

- keep npm package name `hunkdiff`
- keep installed CLI command `hunk`
- remove Bun as an end-user runtime dependency
- make fresh global installs faster and simpler
- preserve a normal `npm i -g hunkdiff` workflow
- keep development workflow Bun-based inside the repo

## Non-goals for the first pass

- Homebrew, apt, or standalone installer work
- changing Hunk's CLI UX
- adding Windows support unless the release pipeline is already straightforward
- solving every CPU baseline edge case on day one if a smaller supported matrix ships sooner

## Recommended package model

### Top-level package

Keep the current root package as the published top-level package:

- name: `hunkdiff`
- bin: `hunk`
- no Bun dependency
- add platform packages in `optionalDependencies`
- ship only the launcher, README, license, and minimal package metadata

Why keep the root package as the published meta package?

- no monorepo conversion required
- `npm pack` from the repo root still verifies the public package
- development dependencies stay dev-only and do not ship
- the current publishing flow changes less

### Platform packages

Create generated publish directories for packages like:

- `hunkdiff-darwin-arm64`
- `hunkdiff-darwin-x64`
- `hunkdiff-linux-x64`
- `hunkdiff-linux-arm64`

Possible later additions:

- `hunkdiff-linux-x64-musl`
- `hunkdiff-linux-arm64-musl`
- `hunkdiff-windows-x64`
- `hunkdiff-windows-arm64`
- x64 baseline variants if Bun/runtime compatibility requires them

Each platform package should contain only:

- `bin/hunk` or `bin/hunk.exe`
- `package.json`
- optionally `README.md` or license if npm/release policy needs it

Example platform manifest shape:

```json
{
  "name": "hunkdiff-linux-x64",
  "version": "0.3.0",
  "os": ["linux"],
  "cpu": ["x64"],
  "files": ["bin"],
  "bin": {
    "hunk": "./bin/hunk"
  },
  "license": "MIT"
}
```

## Launcher design

Replace `bin/hunk.cjs` with a binary-resolving launcher.

Responsibilities:

1. map the current runtime to candidate package names
2. locate the installed platform package under `node_modules`
3. exec the binary with inherited stdio and argv
4. print a clear recovery message if the matching package is missing
5. optionally honor `HUNK_BIN_PATH` for debugging and local smoke tests

### Candidate resolution order

Recommended initial logic:

- macOS:
  - `hunkdiff-darwin-arm64`
  - `hunkdiff-darwin-x64`
- Linux glibc:
  - `hunkdiff-linux-arm64`
  - `hunkdiff-linux-x64`
- Linux musl later, once those packages exist:
  - prefer `*-musl`
  - fall back to glibc package names only if proven safe
- Windows later:
  - `hunkdiff-windows-x64`
  - `hunkdiff-windows-arm64`

For Linux, add musl detection before introducing musl package names:

- `/etc/alpine-release`
- `ldd --version` containing `musl`

For x64 baseline variants, copy opencode's approach only if benchmarking or runtime failures justify the extra package matrix.

## Build strategy

## Recommendation: native per-platform builds, not cross-compilation-first

Bun can compile standalone executables, but cross-platform packaging is the risky part of this migration. The plan should assume native builds in CI first unless Bun cross-compilation is proven reliable for every target we care about.

That means:

- build Linux binaries on Linux runners
- build macOS binaries on macOS runners
- add Windows only when its build and smoke test path is stable

This is more operationally boring, which is good for release infrastructure.

## Suggested repository layout

Generated artifacts only; no large checked-in binary packages:

```text
bin/
  hunk.cjs                      # top-level launcher
scripts/
  build-bin.sh                  # local single-platform dev build
  build-platform-binary.ts      # CI/release build helper
  stage-platform-package.ts     # create dist/npm/<pkg>
  check-top-level-pack.ts
  check-platform-pack.ts
  publish-npm-release.ts        # optional later automation

dist/
  release/
    binaries/
      hunk-linux-x64
      hunk-darwin-arm64
    npm/
      hunkdiff/
      hunkdiff-linux-x64/
      hunkdiff-darwin-arm64/
```

````

The checked-in repo should contain templates and scripts, not prebuilt binaries.

## Release workflow

## Phase 0: measure before changing

Before implementing the new model, capture a baseline for the current Bun-backed npm install:

- fresh `npm i -g hunkdiff` wall-clock time on macOS and Linux
- installed package footprint on disk
- cold `hunk --help` startup time

This avoids shipping a more complex release system without proving the user-visible improvement.

## Phase 1: prototype the packaging model locally

Implement locally first:

1. remove `bun` from top-level runtime dependencies
2. replace `bin/hunk.cjs` with a binary resolver
3. add a script that stages one local platform package from `dist/hunk`
4. test a local install using:
   - top-level package tarball
   - staged platform tarball
   - sanitized PATH without Bun

This proves the launcher and package layout before CI automation.

## Phase 2: build a minimal supported matrix

Recommended first public matrix:

- macOS arm64
- macOS x64
- Linux x64

Possible addition if runner support is easy:

- Linux arm64

Why this scope:

- covers the most likely early adopters
- keeps the first release simpler than a full musl/baseline/Windows matrix
- lets us ship a meaningful improvement before the packaging matrix explodes

## Phase 3: automate staged package creation

For a tagged release:

1. each matrix job builds one compiled binary
2. each matrix job uploads its artifact
3. a packaging job downloads all artifacts
4. the packaging job stages platform package directories with aligned versions
5. the packaging job verifies every package with `npm pack --dry-run`
6. publish platform packages first
7. publish the top-level `hunkdiff` package last

Publishing order matters because the top-level package references exact-version optional dependencies.

## Phase 4: add smoke coverage

CI should verify:

- top-level `npm pack --dry-run` contents
- each platform package tarball contains only expected files
- launcher resolution logic on supported platforms
- fresh global install without Bun on PATH
- `hunk --help` works after install

Minimum CI recommendation:

- Ubuntu smoke job
- macOS smoke job

## Phase 5: expand compatibility only when needed

After the initial rollout, add more variants based on real failures or demand:

- Linux musl packages
- Linux arm64 if not in phase 2
- Windows packages
- x64 baseline variants for older CPUs

## Package manifest changes

Top-level `package.json` should eventually look more like this:

```json
{
  "name": "hunkdiff",
  "bin": {
    "hunk": "./bin/hunk.cjs"
  },
  "files": ["bin", "README.md", "LICENSE"],
  "optionalDependencies": {
    "hunkdiff-darwin-arm64": "0.3.0",
    "hunkdiff-darwin-x64": "0.3.0",
    "hunkdiff-linux-x64": "0.3.0"
  }
}
````

Notably:

- remove `dist/npm` from the published package
- remove runtime dependency on `bun`
- move packaging verification from "does the JS bundle exist" to "does the launcher and package graph exist"

## CI and release files to add or change

Likely changes:

- `bin/hunk.cjs`
  - change from Bun launcher to binary resolver
- `package.json`
  - remove `bun` dependency
  - add `optionalDependencies`
  - shrink published `files`
- `scripts/check-pack.ts`
  - verify top-level meta package shape
- new script for platform tarball verification
- `.github/workflows/ci.yml`
  - add macOS install smoke test job
- new `.github/workflows/release.yml`
  - build matrix, stage packages, publish to npm on tag

## Risks

- release complexity increases meaningfully
- npm optional dependency behavior can vary across package managers
- Linux musl/glibc detection must be correct once those packages exist
- Windows support may require launcher and path special cases
- Bun-compiled binaries may still be large, so install-time improvement must be measured, not assumed

## Rollout recommendation

Use a two-step rollout:

1. prototype behind a branch and measure install/startup improvements
2. ship the binary-package model only when it clearly beats the Bun-backed package on at least macOS and Linux x64

If the gains are modest, keep the release system simple. If the gains are strong, continue to the full opencode-style release flow.

## Acceptance criteria

This plan is complete when Hunk can demonstrate all of the following:

- `npm i -g hunkdiff` works without installing Bun as a runtime dependency
- supported users receive exactly one matching platform binary package plus the tiny meta package
- fresh install time improves versus the Bun-backed path on the tested platforms
- `hunk --help` works on a clean machine after install
- CI verifies install smoke tests on at least Linux and macOS
- README documents supported install targets and unsupported platforms clearly
