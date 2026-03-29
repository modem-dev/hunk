# hunk agent notes

## purpose

- Terminal-first diff viewer for understanding coding-agent changesets.
- Bun + TypeScript + OpenTUI React.
- Product target is "modern desktop diff tool in a terminal", not a pager-style TUI.

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
- `hunk mcp serve` runs one loopback daemon that brokers agent commands to many live Hunk sessions. Normal Hunk sessions should auto-start and register with that daemon when MCP is enabled. Keep it local-only and session-brokered rather than opening per-TUI ports.
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

## code comments

- Add short JSDoc-style comments to functions and helpers.
- Add inline comments for intent, invariants, or tricky behavior that would not be obvious to a fresh reader.
- Skip comments that only narrate what the code already says.

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
- If newly created files should appear in `hunk diff` before commit, use `git add -N <paths>` so they show up in the review stream without staging content.

## commands

- install deps: `bun install`
- run from source: `bun run src/main.tsx -- diff`
- review a commit from source: `bun run src/main.tsx -- show HEAD~1`
- fast smoke test: `bun run src/main.tsx -- diff /tmp/before.ts /tmp/after.ts`
- typecheck: `bun run typecheck`
- tests: `bun test`
- TTY smoke test: `bun run test:tty-smoke`
- build binary: `bun run build:bin`
- install binary: `bun run install:bin`

## binary notes

- Installed `hunk` is a compiled snapshot, not linked to source.
- After source changes, rebuild/reinstall with `bun run install:bin`.
- For rendering verification, prefer a real TTY smoke run over redirected stdout capture.

## verification

- For rendering changes: run `bun run typecheck`, `bun test`, `bun run test:tty-smoke`, and do one real TTY smoke run on an actual diff.
- For interaction, layout, scrolling, navigation, or windowing changes: also add or update integration tests that exercise the user-visible behavior at the pane/app level.
- For CLI, config, or pager work: make sure the relevant source invocation still works (`diff`, `show`, `patch`, or `pager`).
- Preserve current interaction model unless the user asks to change it explicitly.

## repo notes

- Local review artifacts are ignored on purpose. Leave them alone unless the user explicitly wants them updated, and do not commit them.
- Do not auto-commit after making changes. Leave edits uncommitted so the user can review them in `hunk`, and only commit when the user explicitly asks.
- Keep this doc short and architectural. Fresh-context agents can discover file paths themselves.
