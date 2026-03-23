# Contributing to Hunk

Thanks for helping improve Hunk.

Hunk is a review-first terminal diff viewer. Keep changes focused, verify behavior locally, and prefer small PRs over broad rewrites.

## Development setup

Requirements:

- Bun 1.3+
- Node.js 18+
- Git

Install dependencies:

```bash
bun install
```

Run Hunk from source:

```bash
bun run src/main.tsx -- diff
```

## Common commands

Validate a typical change:

```bash
bun run typecheck
bun test
bun run test:tty-smoke
```

Format the JS/TS/JSON codebase:

```bash
bun run format
bun run format:check
```

Lint the JS/TS codebase:

```bash
bun run lint
bun run lint:fix
```

`bun install` also installs a local `pre-commit` hook that runs `lint-staged`, so staged JS/TS files are auto-formatted and linted before commit.

Build and verify the npm package:

```bash
bun run build:npm
bun run check:pack
```

Benchmark scripts live in [`benchmarks/`](benchmarks/README.md).

Common runs:

```bash
bun run bench:bootstrap-load
bun run bench:highlight-prefetch
bun run bench:large-stream
bun run bench:large-stream-profile
```

Build and smoke-test the prebuilt npm packages for the current host:

```bash
bun run build:prebuilt:npm
bun run check:prebuilt-pack
bun run smoke:prebuilt-install
```

Prepare the multi-platform release directories from downloaded artifacts and dry-run publish order:

```bash
bun run build:prebuilt:artifact
bun run stage:prebuilt:release
bun run check:prebuilt-pack
bun run publish:prebuilt:npm -- --dry-run
```

## Validation expectations

- Rendering changes: run `bun run typecheck`, `bun test`, `bun run test:tty-smoke`, and do one real TTY smoke run on an actual diff.
- CLI, config, or pager changes: verify the relevant source invocation still works, such as `diff`, `show`, `patch`, or `pager`.
- Packaging or release changes: run the pack and prebuilt checks locally before opening a PR.

## Architecture

```text
CLI input
  -> parse runtime + config-backed view options
  -> normalize into one Changeset / DiffFile model
  -> App shell coordinates state, layout, and review navigation
  -> pane components render review UI
  -> Pierre-backed terminal renderer draws diff rows
```

Key rules:

- Keep the app review-first: the main pane is one top-to-bottom review stream.
- The sidebar is for navigation. Selecting a file should jump within the main stream, not collapse the review to one file.
- Keep split, stack, and auto layouts driven from the same normalized diff model.
- Preserve mouse and keyboard parity for primary actions.
- Keep agent context beside the code it explains.
- Prefer dedicated helper modules and pane components over growing `App` into a monolith.

## Pull requests

- Keep scope tight and explain user-visible behavior changes clearly.
- Update docs and examples when behavior or workflows change.
- If you want temporary local review notes, you can use `.hunk/latest.json`, but do not commit it.
- If newly created files should appear in `hunk diff` before commit, use `git add -N <paths>`.

## Release notes

- The npm package name is `hunkdiff`.
- The installed CLI command remains `hunk`.
- The automated prebuilt publish workflow lives in `.github/workflows/release-prebuilt-npm.yml`.
