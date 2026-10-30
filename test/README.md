# Test layout

Most unit tests are colocated with the source they cover. The top-level `test/` tree holds tests
that cross module, process, repository, runtime, or terminal boundaries.

## Structure

```text
test/
  helpers/                 shared test-only builders, fixtures, and colocated helper tests
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

| Command                              | Coverage                                                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run test`                       | `packages/`, `scripts/`, `examples/`, `test/cli/`, `test/helpers/`, and `test/session/`, as defined by `scripts/test/run-test-suite.ts` |
| `bun run test:windows`               | Windows platform, process, VCS, CLI, and packaging coverage; Linux owns the terminal UI semantic suite                                  |
| `bun test ./test/review-conformance` | Shared review fixtures and registered consumer projections                                                                              |
| `bun run test:session-broker-node`   | Real Node listener/adapter conformance using the checked-in cross-runtime fixtures                                                      |
| `bun run test:integration`           | PTY-backed tests under `test/pty/`                                                                                                      |
| `bun run test:tty-smoke`             | Opt-in real-TTY smoke tests under `test/smoke/`                                                                                         |
| `bun run test:install-vm`            | Opt-in Firecracker install compatibility scenarios under `test/cli/install-vm/`                                                         |
| `bun run vm:shell [-- --with-hunk]`  | Disposable Ubuntu Firecracker shell, optionally with a fresh local Hunk build                                                           |

npm extension installation tests require npm/Node.js and use a disposable loopback registry
with real tarballs, not public npm. To exercise both the source CLI and a compiled binary:

```sh
bun run build:bin
HUNK_TEST_BINARY="$PWD/dist/hunk" bun test test/cli/npm-extension-install.test.ts
```

`HUNK_TEST_BINARY` is optional; the source CLI case runs in the default suite. On Windows,
set that environment variable to the absolute path of `dist/hunk.exe` before running Bun.

The dedicated trees are not selected directly by `bun run test`, though package tests import some
shared runtime fixtures. Run the commands that match the changed behavior; omission from the default
suite does not mean another command covers it.

## Shell completion compatibility

`test/pty/shell-completion-integration.test.ts` presses Tab in real Bash Readline and Zsh ZLE
sessions. It covers standalone Bash, Bash with an installed `bash-completion` helper, and sourced
and autoloaded Zsh scripts. The fixture's `hunk` shell function only records the resulting
arguments; it never launches the application. These tests are Unix-only and skip missing shells.

Run them directly with:

```bash
bun test test/pty/shell-completion-integration.test.ts
```

Set `HUNK_TEST_BASH_COMPLETION` to test a helper installed outside the detected system/Homebrew
locations. To verify standalone compatibility with a particular Bash executable, including
macOS's Bash 3.2, use:

```bash
HUNK_TEST_BASH_EXECUTABLE=/bin/bash bun test \
  packages/hunk/src/app/shellCompletion.test.ts \
  test/pty/shell-completion-integration.test.ts \
  --test-name-pattern 'shell completion scripts|bash standalone'
```

Replace `/bin/bash` with the desired executable. Run the helper-backed case with the Bash version
supported by that installed helper; modern `bash-completion` versions may themselves require
Bash 4 or newer.

The Windows suite omits the platform-neutral terminal UI semantic tree, which the Linux suite covers,
then runs the focused UI tests for worker startup, editor commands, and workspace path safety. Add new
UI tests to the `windows-ui` group when their behavior depends on Windows platform boundaries.
