# Running real coverage: what actually happened

Follow-up to `README.md`, which measures test-code share because executed-line coverage needs each
project's suite to actually run. This file records the attempt to run them, 2026-08-21, in a
sandbox with a filtered outbound proxy.

## Coverage measured (clean runs, 0–3 failing tests)

| Project | Scope run | Lines | Functions | Tests | Tool |
| --- | --- | ---: | ---: | --- | --- |
| hunk | `src packages scripts test/cli test/session` | 95.2% | 93.9% | 3002 pass / 3 fail | `bun test --coverage` |
| opentui | `packages/core` | 82.7% | 78.6% | 5397 pass / 1 fail | `bun test --coverage` |
| diffs.com | `packages/diffs` | 83.2% | 82.1% | 1510 pass / 0 fail | `bun test --coverage` |
| pi | `packages/{client,protocol,telemetry}` | 89.2% / 97.1% / 99.0% | — | pass | `vitest --coverage.all` |

hunk's 3 failures are daemon/session tests that need a live loopback daemon; opentui's 1 is an
audio-device test. Neither materially moves the number.

## Blocked, and why

| Project | Blocker |
| --- | --- |
| pi (`ai`, `coding-agent`, `agent`, `server`) | Test imports need a generated model catalog; `generate-models` gets 403 from models.dev through the proxy. |
| herdr | `build.rs` compiles vendored `libghostty-vt`, whose zig deps resolve to `deps.files.ghostty.org` — 405 through the proxy. Rust toolchain and `cargo-llvm-cov` were fine. |
| libghostty | 33 of 38 entries in `build.zig.zon` point at `deps.files.ghostty.org` — same 405. Zig 0.16.0 itself had to come from PyPI's `ziglang` wheel because ziglang.org is 403. |
| opencode | `bun install` cannot resolve `github:anomalyco/ghostty-web` — 403, outside this session's repo scope. |

Zig has no built-in coverage instrumentation and ghostty's CI does not produce a coverage number,
so even a successful build would have needed kcov on top.

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
