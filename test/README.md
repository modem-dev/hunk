# Test layout

Most unit tests are colocated with the source they cover. The top-level `test/` tree holds tests
that cross module, process, repository, runtime, or terminal boundaries.

## Structure

```text
test/
  helpers/                 shared test-only builders and fixtures
  fixtures/                runtime-neutral cross-process fixtures
  cli/                     black-box CLI contracts
  session/                 daemon, broker, and session CLI flows
  review-conformance/      shared semantic fixtures and consumer projections
  session-broker-node/     real Node adapter conformance
  session-broker-runtime/  shared Bun/Node connection fixtures
  pty/                     live PTY-driven UI integration
  smoke/                   opt-in terminal transcript checks
```

## Placement

- Keep a test beside one module or helper when it can exercise that owner directly.
- Put shared unit-test builders in `test/helpers/` and name them explicitly as test-only helpers.
- Use `test/cli/` for spawned entrypoint behavior such as help, version, pager fallback, and errors.
- Use `test/session/` for cross-process daemon, broker, and session CLI flows.
- Use `test/review-conformance/` for hand-authored review semantics and every registered consumer's
  real projection.
- Use `test/session-broker-node/`, `test/session-broker-runtime/`, and `test/fixtures/` for portable
  broker adapter behavior and shared cross-runtime fixtures.
- Use `test/pty/` for resize, navigation, mouse, layout, scrolling, and note visibility in a live UI.
- Use `test/smoke/` for transcript-level rendering checks on a real TTY.

## Commands and coverage

| Command                              | Coverage                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `bun run test`                       | `packages/`, `scripts/`, `examples/`, `test/cli/`, and `test/session/`, as defined by `scripts/test/run-test-suite.ts` |
| `bun test ./test/review-conformance` | Shared review fixtures and registered consumer projections                                                             |
| `bun run test:session-broker-node`   | Real Node listener/adapter conformance using the checked-in cross-runtime fixtures                                     |
| `bun run test:integration`           | PTY-backed tests under `test/pty/`                                                                                     |
| `bun run test:tty-smoke`             | Opt-in real-TTY smoke tests under `test/smoke/`                                                                        |

The dedicated trees are not selected directly by `bun run test`, though package tests import some
shared runtime fixtures. Run the commands that match the changed behavior; omission from the default
suite does not mean another command covers it.
