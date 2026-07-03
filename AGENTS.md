# hunk agent notes

## purpose

- Terminal-first diff viewer for understanding coding-agent changesets.
- Product target is "modern desktop diff tool in a terminal", not a pager-style TUI.

## major dependencies

- [Bun](https://bun.sh) runtime and package manager
- [OpenTUI](https://github.com/anomalyco/opentui) React terminal UI framework
- [Pierre](https://www.npmjs.com/package/@pierre/diffs) diff engine and terminal renderer

## architecture

```text
CLI input
  -> parse runtime + config-backed view options
  -> normalize into one Changeset / DiffFile model
  -> App shell coordinates state, layout, and review navigation
  -> pane components render review UI
  -> Pierre-backed terminal renderer draws diff rows
```

- CLI entrypoints: `diff`, `show`, `stash show`, `patch`, `pager`, `difftool`.
- All input sources normalize into one internal changeset model.
- Pager mode has two paths: full diff UI for patch-like stdin, plain-text fallback for non-diff pager content.
- View defaults are layered through built-ins, user config, repo `.hunk/config.toml`, command sections, pager sections, and CLI flags.
- `hunk daemon serve` runs one loopback daemon that brokers agent commands to many live Hunk sessions. Normal Hunk sessions should auto-start and register with that daemon when session brokering is enabled. Keep it local-only and session-brokered rather than opening per-TUI ports.
- Agent rationale is optional sidecar JSON matched onto files/hunks.
- The order of `files` in the sidecar is intentional. Hunk uses that order for the sidebar and main review stream.
- Prefer one source of truth for each user-visible behavior. When rendering, navigation, scrolling, or note placement share the same model, derive them from the same planning layer rather than maintaining parallel implementations.
- When UI behavior depends on derived structure or metrics, make that structure explicit in helper modules and reuse it across rendering and interaction code instead of re-deriving it ad hoc in multiple places.
- If a new implementation makes an older path obsolete, remove the dead path instead of keeping two overlapping systems around.

## architectural rules

- Keep the app review-first: the main pane is a single top-to-bottom stream of all visible file diffs.
- The sidebar is for navigation. Selecting a file jumps to that file in the main review stream; it should not collapse the main pane to one file.
- Keep Pierre as the diff engine and renderer foundation. Do not switch the main renderer back to OpenTUI's built-in `<diff>` widget.
- Keep split and stack views terminal-native and driven from the same normalized diff model.
- Preserve mouse + keyboard parity for primary actions.
- Keep the chrome restrained: top menu bar, minimal borders, no redundant metadata headers.

## component guidance

- `App` should remain the orchestration shell for app state, navigation, layout mode, theme, filtering, and pane coordination.
- Pane rendering should live in dedicated components.
- New UI work should extend existing components or add new ones, not grow `App` back into a monolith.
- Shared formatting, ids, and small derivations belong in helper modules, not repeated inline.
- Prefer one implementation path per feature instead of separate "old" and "new" codepaths that duplicate behavior.
- When refactoring logic that spans helpers and UI components, add tests at the level where the user-visible behavior actually lives, not only at the lowest helper layer.

## theme guidance

- Built-in themes live in `src/ui/themes/<theme-id>.ts`; register them in `src/ui/themes.ts` `THEMES` to control menu/cycle order.
- When adding or renaming a built-in theme, update config validation, OpenTUI theme exports, docs/README examples, changelog, and tests that assert theme order.
- Keep official palette tokens separate from Hunk's semantic `AppTheme` mapping, and cover non-trivial derived colors with tests.

## testing

- Colocate unit tests with the code they cover (`src/core/foo.ts` + `src/core/foo.test.ts`, `src/ui/AppHost.*.test.tsx`, `src/ui/lib/*.test.ts`).
- Put shared unit-test helpers in `test/helpers/`.
- Name test helpers so they explicitly include `Test` and are clearly test-only (`createTestDiffFile`).
- Use repo-level `test/` directories by intent:
  - `test/cli/` for black-box CLI contract coverage.
  - `test/session/` for daemon/session integration and end-to-end flows.
  - `test/pty/` for PTY-backed live UI integration tests.
  - `test/smoke/` for opt-in terminal transcript smoke coverage.

## code comments

- Add short JSDoc-style comments to functions and helpers.
- Add inline comments for intent, invariants, or tricky behavior that would not be obvious to a fresh reader.
- Skip comments that only narrate what the code already says.

## naming

- Prefer names that match the role the code plays in the product and architecture.
- Use `layout` for structural placement or arrangement data.
- Use `geometry` for aggregate spatial data used by rendering, scrolling, or interaction.
- Use `bounds` for one concrete visible extent within a larger structure.

## review behavior

- Default behavior is a multi-file review stream in sidebar order.
- Layout modes: `auto`, `split`, `stack`.
- `auto` should choose split on wide terminals and stack on narrow ones.
- Explicit `split` and `stack` choices override responsive `auto` layout selection.
- `[` and `]` navigate hunks across the full review stream. Do not reintroduce `j`/`k` hunk navigation unless the user asks.
- Agent context belongs beside the code, not hidden in a separate mode or workflow.
- Agent notes are hunk-specific: show notes for the selected hunk, render them in the diff flow near the annotated row, and keep a clear spatial relationship to the code they explain.
- Keep note behavior explicit. If the UI intentionally prioritizes one note, one selection, or one active target, encode that as a named policy rather than scattering array-index assumptions through the codebase.
- If you choose to use a local sidecar for temporary review context, keep it concise and review-oriented: one changeset summary, file summaries in narrative order, and a few hunk-level annotations with real rationale.
- If a local sidecar is present, its file order is intentional, but the visible note UI should stay hunk-note driven rather than showing generic file or changeset explainer cards.
- `hunk diff` working-tree reviews include untracked files by default. Use `--exclude-untracked` if you explicitly want tracked changes only.
- Agents review via `skills/hunk-review/SKILL.md` using `hunk session *` commands; do not run interactive TUI commands directly.

## commands

- install deps: `bun install`
- run from source: `bun run src/main.tsx -- diff`
- review a commit from source: `bun run src/main.tsx -- show HEAD~1`
- fast smoke test: `bun run src/main.tsx -- diff /tmp/before.ts /tmp/after.ts`
- typecheck: `bun run typecheck`
- tests: `bun test`
- PTY integration tests: `bun run test:integration`
- TTY smoke test: `bun run test:tty-smoke`
- format: `bun run format`
- lint: `bun run lint`
- build binary: `bun run build:bin`
- install binary: `bun run install:bin`

## binary notes

- Installed `hunk` is a compiled snapshot, not linked to source.
- After source changes, rebuild/reinstall with `bun run install:bin`.
- For rendering verification, prefer a real TTY smoke run over redirected stdout capture.

## verification

- For rendering changes: run `bun run typecheck`, `bun test`, `bun run test:integration`, `bun run test:tty-smoke`, and do one real TTY smoke run on an actual diff.
- For interaction, layout, scrolling, navigation, windowing, or other terminal-native behavior: add or update PTY integration coverage in `test/pty/*-integration.test.ts` and run it with `bun run test:integration`.
- For CLI, config, or pager work: make sure the relevant source invocation still works (`diff`, `show`, `patch`, or `pager`).
- Preserve current interaction model unless the user asks to change it explicitly.

## cross-platform support

- Hunk should work on macOS, Linux, and Windows. Keep tests and CI portable unless a case is explicitly Unix-only (PTY/TTY smoke coverage is Unix-only).
- In tests, avoid hard-coded POSIX paths, separators, shell syntax, and filenames invalid on Windows; use Node path helpers for real filesystem paths while preserving user-provided/protocol paths when pass-through is intentional.
- If Windows-only Bun behavior appears around timers, sockets, or line endings, prefer a small compatibility fix or a narrowly scoped skip with a comment over broadening Unix assumptions.

## releases

- Use Changesets for user-visible release notes. Add a `.changeset/*.md` entry with `bun run changeset` instead of editing `CHANGELOG.md` directly.
- Target the public `hunkdiff` package in changesets. Use `patch` for fixes and small behavior changes, `minor` for new user-facing features, and `major` for breaking changes.
- For maintenance-only PRs that should not appear in release notes, add an empty changeset with `bun run changeset -- --empty`.
- Keep the top-level `CHANGELOG.md` as the released changelog artifact. It is updated during release prep with `bun run release:version`, not by normal feature/fix PRs.
- Use the released changelog section as the starting point for the GitHub release body.
- GitHub releases should follow this format:

  ```md
  ## What's Changed

  - <change title> by @<author> in <PR URL>
  - ...

  **Full Changelog**: https://github.com/modem-dev/hunk/compare/<previous-tag>...<new-tag>
  ```

- Do not rely blindly on autogenerated GitHub release notes. After publishing, verify the release body and edit it if needed.
- Prefer `gh release create/edit --notes-file` for multi-line release notes so the exact body is reviewed before posting.
- After publishing, verify npm packages, GitHub release assets, and the Homebrew tap formula all point at the new version. If Homebrew automation fails, update `modem-dev/homebrew-tap` manually using the release assets and record/fix the failing credential or workflow issue.
- For patch releases and backports, list only changes actually present between the previous tag and the new tag on that release branch.
- Prefer concise, user-visible entries over internal refactors unless the refactor changes user-visible behavior.

## repo notes

- Local review artifacts are ignored on purpose. Leave them alone unless the user explicitly wants them updated, and do not commit them.
- Keep this doc short and architectural. Fresh-context agents can discover file paths themselves.

## commits

Commit titles should follow Conventional Commits. Format: `<type>[scope]: <description>`. Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`. Use `!` or `BREAKING CHANGE:` footer for breaking changes. Description should explain the "why", not just the "what".
