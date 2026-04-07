# Test layout

Most Hunk tests are colocated in `src/` beside the code they cover.

The top-level `test/` tree is reserved for cases that intentionally exercise the product across module, process, repo, or terminal boundaries.

## Structure

```text
test/
  helpers/   shared unit-test fixtures
  cli/       black-box CLI contracts
  session/   daemon, broker, and session-CLI flows
  pty/       live PTY-driven UI integration
  smoke/     thin terminal transcript sanity checks
```

## What lives here

- `test/helpers/` — shared test-only builders and fixtures reused by colocated unit tests.
- `test/cli/` — black-box CLI contract tests that spawn the real entrypoint and assert help, version, pager fallback, and friendly error output.
- `test/session/` — daemon, broker, and session-CLI coverage. These tests often start subprocesses, create temp repos/files, and verify cross-process behavior.
- `test/pty/` — PTY-backed live UI integration tests for resize, navigation, mouse input, layout changes, and note visibility.
- `test/smoke/` — opt-in terminal transcript smoke coverage for real TTY rendering (`bun run test:tty-smoke`).

## Why these are not colocated

These tests do not belong to a single source file. They usually verify product-level behavior such as:

- command-line contracts
- subprocess and daemon lifecycle
- live session brokering
- PTY / terminal rendering behavior
- full review-flow interactions across multiple modules

If a test mainly targets one module or helper, keep it colocated in `src/`.
If it needs a real repo, subprocess, daemon, PTY, or transcript-level assertion, it likely belongs under `test/`.
