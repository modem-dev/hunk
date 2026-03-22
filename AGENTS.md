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
- `hunk mcp serve` runs one loopback daemon that brokers agent commands to many live Hunk sessions. Keep it local-only and session-brokered rather than opening per-TUI ports.
- Agent rationale is optional sidecar JSON matched onto files/hunks.
- The order of `files` in the sidecar is intentional. Hunk uses that order for the sidebar and main review stream.

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

## review behavior

- Default behavior is a multi-file review stream in sidebar order.
- Layout modes: `auto`, `split`, `stack`.
- `auto` should choose split on wide terminals and stack on narrow ones.
- Explicit `split` and `stack` choices override responsive `auto` layout selection.
- `[` and `]` navigate hunks across the full review stream. Do not reintroduce `j`/`k` hunk navigation unless the user asks.
- Agent context belongs beside the code, not hidden in a separate mode or workflow.
- Agent notes are hunk-specific: show notes for the selected hunk, render them in the diff flow near the annotated row, and keep a clear spatial relationship to the code they explain.
- When making code changes in this repo, also refresh `.hunk/latest.json` so the next review can load agent rationale with `hunk diff --agent-context .hunk/latest.json`.
- Keep `.hunk/latest.json` concise and review-oriented: one changeset summary, file summaries in narrative order, and a few hunk-level annotations with real rationale.
- File order in `.hunk/latest.json` is intentional, but the visible note UI should stay hunk-note driven rather than showing generic file or changeset explainer cards.
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
- For CLI, config, or pager work: make sure the relevant source invocation still works (`diff`, `show`, `patch`, or `pager`).
- Preserve current interaction model unless the user asks to change it explicitly.

## repo notes

- `.hunk/latest.json` is ignored on purpose. Update it when you change code, but do not commit it.
- Do not auto-commit after making changes. Leave edits uncommitted so the user can review them in `hunk`, and only commit when the user explicitly asks.
- Keep this doc short and architectural. Fresh-context agents can discover file paths themselves.
