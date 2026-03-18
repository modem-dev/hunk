# opentui-diff agent notes

## purpose

- Terminal-first diff viewer for understanding coding-agent changesets.
- Bun + TypeScript + OpenTUI React.
- Product target is "modern desktop diff tool in a terminal", not a pager-style TUI.

## architecture

```text
CLI input
  -> normalize into one Changeset / DiffFile model
  -> App shell coordinates state and pane layout
  -> pane components render review UI
  -> Pierre-backed terminal renderer draws diff rows
```

- Input modes: `git`, `diff`, `patch`, `difftool`.
- All input sources normalize into one internal changeset model.
- Agent rationale is optional sidecar JSON matched onto files/hunks.

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
- Agent context belongs beside the code, not hidden in a separate mode or workflow.

## commands

- install deps: `bun install`
- run from source: `bun run src/main.tsx -- git`
- fast smoke test: `bun run src/main.tsx diff /tmp/before.ts /tmp/after.ts`
- typecheck: `bun run typecheck`
- tests: `bun test`
- build binary: `bun run build:bin`
- install binary: `bun run install:bin`

## binary notes

- Installed `otdiff` is a compiled snapshot, not linked to source.
- After source changes, rebuild/reinstall with `bun run install:bin`.
- For rendering verification, prefer a real TTY smoke run over redirected stdout capture.

## verification

- For rendering changes: run `bun run typecheck`, `bun test`, and do one real TTY smoke run on an actual diff.
- Preserve current interaction model unless the user asks to change it explicitly.

## repo notes

- There is an unrelated untracked file named `md` in the repo root. Leave it alone unless the user asks.
- User asked for commits along the way. Prefer small milestone commits rather than one large final commit.
- Keep this doc short and architectural. Fresh-context agents can discover file paths themselves.
