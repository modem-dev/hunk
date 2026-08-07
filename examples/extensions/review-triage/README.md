# Review triage extension

A session-local hunk review board for Hunk. It records which hunks you have visited and lets you mark the selected hunk **approved**, **investigate**, or **blocked** with an optional rationale.

Run it directly from this checkout:

```bash
bun run src/main.tsx -- diff --extension ./examples/extensions/review-triage
```

Or copy the directory to your Hunk extensions directory and keep its `package.json`; its manifest makes the folder a single `review-triage` extension.

## Use

Open **Extensions → Toggle review triage** (`y`). The right sidebar lists each visible file's hunks; click a hunk to navigate the review stream. Use **Extensions → Mark selected hunk…** (`x`) to choose a status and enter an optional rationale. **Set review focus…** and **Clear triage decisions** are menu-only commands.

The board intentionally keeps state only for the running Hunk session. Reloading reconciles decisions against the newly parsed hunks and drops entries that no longer match, rather than silently transferring a decision to changed code.

## API surface exercised

- `registerSidebarView` renders public file/hunk summaries and navigates with sidebar actions.
- `registerCommand` supplies the Extensions-menu items and user-remappable defaults.
- `dialogs.select`, `dialogs.input`, and `dialogs.confirm` implement the review decision and clear flows.
- Lifecycle handlers track changeset loads, reloads, selection, viewed hunks, Hunk notes, filters, and pending watch reloads through a `useSyncExternalStore` bridge.
- `hunk.events` publishes decisions and listens for `review-triage:open`, so another extension can reveal the board without importing its state.
