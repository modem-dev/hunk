# Test-code share across recent OSS dev tools

One-off snapshot (2026-08-20) of how much of each repository is test code.

## Metric

`test lines ÷ (test lines + source lines)`, counted over every checked-in code file:

- Non-blank, non-comment-only lines only.
- Test code = files under `test/`, `tests/`, `__tests__/`, `spec/`, `testdata/`, `e2e/`,
  or named `*.test.*`, `*_test.*`, `*.spec.*`, plus inline test blocks that Zig
  (`test "…" {}`) and Rust (`#[cfg(test)] mod`, `#[test] fn`) keep inside source files.
  Those are brace-matched out of their host file so the host's real source lines still count.
- Excluded: generated files (`@generated`/`DO NOT EDIT` headers, `generated/` dirs), vendored
  trees, `node_modules`, build output, `.d.ts`, minified bundles, and non-code assets (CSS, docs).
- Whole repo at HEAD, no per-project scoping, so monorepos carry their web and docs apps too.

This is a proxy for investment in tests, not executed-line coverage — running seven test suites
across Bun, Cargo, and Zig would measure runner configuration as much as code.

## Results

| Project | Repo | Source | Test | Test share |
| --- | --- | ---: | ---: | ---: |
| hunk | modem-dev/hunk | 65,715 | 77,472 | 54.1% |
| herdr | ogulcancelik/herdr | 118,747 | 108,446 | 47.7% |
| opentui | sst/opentui | 184,817 | 156,945 | 45.9% |
| pi | earendil-works/pi | 121,269 | 100,309 | 45.3% |
| diffs.com | pierrecomputer/pierre | 137,604 | 76,497 | 35.7% |
| libghostty | ghostty-org/ghostty | 171,449 | 93,474 | 35.3% |
| opencode | sst/opencode | 411,928 | 168,944 | 29.1% |

Scoping matters for the monorepos: measured at their core packages instead of whole repo,
`sst/opencode`'s `packages/opencode` is 54.3% tests, `sst/opentui`'s `packages/core` is 58.6%,
`pierre`'s `packages/diffs` is 50.8%, and ghostty's `src/` Zig core is 40.5%.

## Reproducing

```sh
bun run docs/analysis/oss-test-share/measure-test-share.ts <path-to-repo>
```

`card.html` is the shareable visualization of the table above.
