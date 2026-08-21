# Running real coverage: what actually happened

Follow-up to `README.md`, which measures test-code share because executed-line coverage needs each
project's suite to actually run. This file records the attempt to run them, 2026-08-21, in a
sandbox with a filtered outbound proxy. Five of the seven produced a number; `coverage-card.html`
visualizes the result.

## Coverage measured

| Project | Scope run | Lines | Functions | Tests | Tool |
| --- | --- | ---: | ---: | --- | --- |
| hunk | `src packages scripts test/cli test/session` | 95.2% | 93.9% | 3002 pass / 3 fail | `bun test --coverage` |
| diffs.com | `packages/diffs` | 83.2% | 82.1% | 1510 pass / 0 fail | `bun test --coverage` |
| opentui | `packages/core` | 82.7% | 78.6% | 5397 pass / 1 fail | `bun test --coverage` |
| opencode | `packages/opencode` | 78.3% | 66.5% | 3286 pass / 12 fail | `bun test --coverage` |
| pi | 7 of 10 packages | 68.4% | — | 4299 pass / 61 fail | `vitest --coverage.all` |

hunk's 3 failures are daemon/session tests that need a live loopback daemon; opentui's 1 is an
audio-device test; pi's 61 are model-pricing assertions against the catalog described below.

pi per package: `telemetry` 99.0%, `protocol` 97.1%, `client` 89.2%, `agent` 83.5%, `ai` 81.4%,
`server` 72.6%, `coding-agent` 60.4%.

## Workarounds that unblocked a run

- **pi** needs a generated model catalog and `generate-models` gets 403 from models.dev. The
  published `@earendil-works/pi-ai` tarball ships the same JSON under `dist/providers/data`, so
  `npm pack` plus a copy into `src/providers/data` gets the suites running; the 61 failures are
  pricing assertions where the published catalog and the checkout disagree.
- **Vitest writes no coverage report when a run fails** unless `--coverage.reportOnFailure` is set.
  That, not the failures themselves, is why four pi packages first looked unmeasurable.
- **Zig** came from PyPI's `ziglang` wheel (0.16.0 and 0.15.2) because ziglang.org is 403.
- **opencode**'s install was not blocked by the GitHub dependency after all — dropping that
  web-app-only `ghostty-web` entry got past it, and the install then stalled silently for 90
  minutes retrying `@solidjs/start`, pinned to a **pkg.pr.new** preview build the proxy rejects.
  Removing that dependency (catalog plus `enterprise`, `stats/app`, `console/app`,
  `console/support` — none of which the CLI suite imports) lets the install finish. `@opentui` is
  not hoisted to the root `node_modules`; it lands in `packages/opencode/node_modules`.
- **uucode**, herdr's first blocked zig dep, resolved from upstream: a `zig fetch` of
  `jacobsandlund/uucode` at tag `v0.2.0` hashes to exactly the
  `uucode-0.2.0-ZZjBPqZVVABQepOqZHR7vV_NcaN-wats0IB6o-Exj6m9` the mirror serves, so populating the
  global cache from GitHub satisfies the build without touching the blocked host.

## Blocked, and why

| Project | Blocker |
| --- | --- |
| herdr | After uucode, `build.rs` still needs 10 more mirrored C deps (wuffs, oniguruma, libpng, highway, harfbuzz, freetype, fontconfig, libxml2, dcimgui) from `deps.files.ghostty.org` — 405 through the proxy. Upstreams for several are on hosts the proxy also denies, and mirrored release tarballs would not hash-match a git checkout the way uucode did. |
| libghostty | 33 of 38 entries in `build.zig.zon` point at the same host. |

Zig has no built-in coverage instrumentation and ghostty's CI does not produce a coverage number,
so even a successful build would have needed kcov — which is not in apt here and whose GitHub
release binaries are not downloadable over the proxy's git-only GitHub access.

## Why the three numbers are still not comparable

`bun test --coverage` only instruments files the tests actually import — opentui's report covers
130 of 163 source files in `packages/core/src`, so files no test touches are absent from the
denominator rather than counted as uncovered. Vitest with `coverage.all` and `cargo llvm-cov` count
every file in scope. A cross-project coverage ranking would be comparing three different
denominators, which is why the shareable card measures test-code share instead.

## Reproducing

```sh
bun test --coverage --coverage-reporter=lcov --coverage-dir=<out> <paths>   # bun projects
npx vitest --run --coverage --coverage.all --coverage.reporter=json-summary # pi packages
cargo llvm-cov --workspace --summary-only --no-fail-fast                    # herdr (needs zig)
```
