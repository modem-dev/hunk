---
title: Extension API
description: Register themes, file previews, keyboard modes, transforms, commands, dialogs, and events through the extension API object.
---

The extension factory receives one API object. Registration calls are only valid while the factory is running; Hunk seals the object afterwards so a deferred callback cannot mutate the registry mid-session. This page indexes the whole object; larger registration calls are documented in depth on their own pages and summarized in place below.

## `hunk.apiVersion`

The API generation this Hunk speaks (currently `9`). Branch on it if you want one file to support several Hunk versions. Version 9 adds exact-filename and glob selectors to `registerFileLanguage`; version 8 added authoritative review snapshots to command handlers; version 7 added the current source line to command selection snapshots. Version 6 added session behavior, terminal-command observation, and live navigation/dialogs in lifecycle and bus handlers; version 5 added line highlighters and line-granular navigation (`revealLine`); version 4 added keyboard modes and docked panes, with API-v3 sidebar names remaining as deprecated aliases.

## `hunk.configureSession(options)`

Request host behavior for the review session loading the extension. Training,
demo, and presentation extensions can make their view-setting changes temporary:

```ts
hunk.configureSession({ viewPreferences: "transient" });
```

If any loaded extension requests this, Hunk skips the save-view-preferences
prompt on quit instead of offering to write practice state into user config.
The default is `"default"`.

## `hunk.registerTheme(theme)`

Contribute one selectable theme. The object is the same shape as a `[themes.<id>]` config table:

```ts
hunk.registerTheme({
  id: "midnight-review",
  label: "Midnight Review",
  base: "catppuccin-mocha",
  accent: "#7fd1ff",
  syntaxScopes: { "keyword.operator": "#7fd1ff" },
});
```

Theme ids are lowercase words separated by `-` or `_` and cannot reuse a built-in id. Config-defined themes win over extension themes for the same id. Extension themes appear in the selector after config themes, in load order.

## `hunk.registerFileLanguage(matcher, language)`

Map an extension, exact filename, or glob to an existing syntax-highlighting language. A string remains shorthand for a case-insensitive extension:

```ts
hunk.registerFileLanguage(".zig", "zig");
hunk.registerFileLanguage({ kind: "filename", value: "BUILD" }, "python");
hunk.registerFileLanguage(
  { kind: "glob", value: "generated/**/*.proto", target: "path" },
  "protobuf",
);
```

Filename and glob matching is case-sensitive. Filename selectors match at any directory depth; globs explicitly target the basename or review path exactly as decoded. `/` is the path separator and backslashes stay literal. VCS review paths are normally repo-relative, while generic patches may carry absolute paths. Hunk's reserved `.mts` and `.cts` mappings run first and cannot be overridden. Otherwise, exact filenames take precedence over globs, then extensions. Later registrations win ties.

This selects a grammar already available to Pierre/Shiki; it does not load a new syntax grammar.

## `hunk.registerVcsAdapter(adapter)`

Contribute an additional version-control backend — the same call Hunk's own bundled Git, Jujutsu, and Sapling backends make. An adapter declares `detect`, its `operations` (`working-tree-diff`, `revision-show`, `stash-show`), and optionally detection priority, watch support, exact file sources, extra files, and rich user-fixable failures.

Full contract: [VCS adapters](/docs/extend/vcs-adapters/).

## `hunk.registerPane(pane)`

Render a React component on the `left`, `right`, `top`, or `bottom` of the review. Panes receive their dimensions, review state, actions, keybindings, and optional current-line paint. `registerSidebarView` remains a deprecated alias.

Full contract: [Custom panes](/docs/extend/custom-sidebars/).

## `hunk.registerFileView(view)`

Contribute an opt-in alternate presentation for matching files. A view receives the public file and hunk model, typed change ranges, terminal width, cancellation, and lazy exact-source reads. It returns deterministic symbolic rows, optional fixed-height React/OpenTUI row painters, source bindings for inline notes, and positional hunk extents.

Raw diff remains the default and fallback. Hunk continues to own review-stream geometry, scrolling, windowing, hunk navigation, selection, and note rendering.

Full contract and examples: [File previews](/docs/extend/file-previews/).

## `hunk.registerLineHighlighter(highlighter)`

Mark character ranges inside Hunk's own diff rendering — search hits, diagnostics, secret scanning, coverage — without replacing the file's presentation. Syntax highlighting, word diff, and layout stay intact; the marked characters get a resolved background.

```ts
hunk.registerLineHighlighter({
  id: "todos",
  highlight({ file }) {
    // Scan file.patch (or a readDocument result) and return marks.
    return [{ side: "new", line: 12, range: [4, 8], tone: "warning" }];
  },
});
```

Marks are addressed by source coordinates — `side`, a 1-based `line`, and a `[start, end)` range in UTF-16 code units of the raw line text — so they survive split vs stack layout, wrapping, horizontal scrolling, and collapsed-context expansion. A mark paints terminal columns, so a range covering only zero-width characters (bidi controls, ZWSP) paints nothing. Tones (`match`, `current`, `info`, `warning`, `error`) rather than colors: Hunk resolves each tinted tone against the actual background of each marked line with a minimum-contrast guarantee stronger than its own word-diff emphasis, so a mark is never invisible on an added line's green; on a transparent cell the tint is resolved against the background Hunk assumes rather than the one behind the terminal. `current` renders as reverse video, the `less`/vim convention for the active hit.

`highlight` may be sync or async and is treated as a pure derivation of the file plus an invalidation epoch: results are cached until `ctx.highlights.refresh("todos")` (optionally `{ fileId }`-scoped) re-derives them. Failures, oversized results, and invalid entries cost that file's marks and nothing else — highlights change colors, never text or geometry.

Full contract: [authoring guide](https://github.com/modem-dev/hunk/blob/main/docs/extensions.md#hunkregisterlinehighlighterhighlighter).

## `hunk.transformChangeset(fn)`

Rewrite the loaded changeset before it reaches the review UI. Transforms run in registration order, each seeing the previous one's output, on first load and on every reload.

```ts
hunk.transformChangeset((changeset) => ({
  ...changeset,
  files: changeset.files.filter((file) => !file.path.endsWith(".lock")),
}));
```

The function may be async. Filtering and reordering `files` is fully supported — panes and the review stream follow whatever you return.

Each file carries an opaque `metadata` field — the parsed diff the renderer draws from — so pass it through untouched; spreading a file preserves it. Returns are validated: a transform that throws or returns something the review UI cannot draw is skipped, and the previous changeset carries forward.

You never need `metadata` to know a file's hunks: the read-only views Hunk hands outward (event payloads, pane props, a command's selection) carry a `hunks` list of public summaries — `index`, the `@@` header, and the inclusive old/new line spans, in render order. Like `changeType`, it is derived at that boundary; a transform neither receives nor produces it.

## `hunk.registerKeyboardMode(mode)`

Register a session-wide, deliberately activated keyboard interpretation. Modes receive frozen plain key snapshots after dialogs, menus, focused inputs, and interactive file views, but before Hunk's ordinary command table.

```ts
hunk.registerKeyboardMode({
  id: "normal",
  title: "Vim navigation",
  onKey(key, ctx) {
    if (key.sequence !== "j") return "pass";
    ctx.commands.execute("hunk.review.stepDown");
    return "handled";
  },
});

hunk.registerCommand({ id: "vim", title: "Toggle Vim navigation", key: "ctrl+v" }, (ctx) => {
  if (ctx.keyboardModes.isActive("normal")) ctx.keyboardModes.exitMode();
  else ctx.keyboardModes.enterMode("normal");
});
```

`onKey` returns `"handled"`, `"pass"`, or `"exit"` synchronously. Optional `onEnter`/`onExit` callbacks reset extension-owned state such as counts and pending sequences; while either lifecycle callback runs, `enterMode()` and `exitMode()` return `false`. The context exposes only `cwd`, `notify`, public `commands`, activation-scoped `keyboardModes` controls, and `highlights` refresh controls. Those controls become inert on exit, so retained callbacks cannot replace a later mode. When the session mode is the highest-priority input owner, host-owned Escape exits it; the persistent status badge and Extensions-menu exit are clickable too.

One session mode runs at a time. Entering another runs the outgoing `onExit` first. Focused dialogs and file-view modes temporarily outrank, rather than destroy, a session mode. Content soft reloads preserve it; extension reload, registry closure, and App teardown retire it. See the complete [authoring guide](https://github.com/modem-dev/hunk/blob/main/docs/extensions.md#session-keyboard-modes) and [`vim-navigation` example](https://github.com/modem-dev/hunk/tree/main/examples/extensions/vim-navigation), which includes counts, Ctrl chords, and a focused `:` command line.

## `hunk.registerCommand(command, handler)`

Register a named command, optionally bound to a key. Commands are the same mechanism Hunk's own shortcuts dispatch through — one table, one loop, built-ins first.

```ts
import type { HunkExtensionAPI } from "hunkdiff/extension";

export default function (hunk: HunkExtensionAPI) {
  hunk.registerCommand({ id: "hello", title: "Say hello", key: "ctrl+g" }, (ctx) => {
    ctx.notify("hello from a command");
  });
}
```

Key chords join `ctrl`, `alt`/`option`, `cmd`/`meta`, and `shift` with `+` around a character or named key. For shifted symbols or digits, bind the resulting character (`"!"`, not `"shift+1"`). `ctrl+<letter>` also matches an unnamed bare control byte; named keys stay distinct. `key` may be a list. Omit it for no binding. Existing bindings keep priority.

Declared keys are defaults: users remap commands by id in their `[keybindings]` table — yours is `"<extensionId>.<commandId>"`. See [`docs/keybindings.md`](https://github.com/modem-dev/hunk/blob/main/docs/keybindings.md).

Registered commands are also listed in the menu bar's **Extensions** menu under their `title`, showing whichever key they currently answer to — a command with no binding is still reachable with the mouse.

The handler fires when the key is pressed outside modal UI (dialogs, menus, and focused text inputs own their keys). It receives the standard context plus:

- `ctx.commands.isEnabled(commandId)` / `execute(commandId, { count? })` — probes or invokes an explicitly public built-in `hunk.*` command through the same live table as keyboard and menu actions. Relative movement applies counts atomically; extension-owned and cross-extension commands return `false`.
- `ctx.keyboardModes.enterMode(id)` / `exitMode()` / `isActive(id?)` — controls only keyboard modes registered by this command's owning extension.
- `ctx.panes.open(paneId)` / `close(paneId)` / `toggle(paneId)` / `isOpen(paneId)` — controls your panes by bare id or any pane by its fully qualified `"<extensionId>:<paneId>"` key, including `"hunk:files"`. `ctx.sidebars` is deprecated.
- `ctx.fileViews.select(viewId)` / `toggle(viewId)` / `isActive(viewId)` — controls a matching [file preview](/docs/extend/file-previews/) for the current file; `select(null)` restores raw diff.
- `ctx.fileViews.refresh(viewId, options?)` — marks that view's prepared layouts stale so a stateful view re-derives; every file presenting it re-lays out, keeping its current rows visible until the replacement resolves. Pass `{ fileId }` to scope the invalidation to one reviewed file's presentation of the view.
- `ctx.fileViews.enterMode(viewId)` / `exitMode()` / `isModeActive(viewId)` — starts, stops, or checks an [interactive preview](/docs/extend/file-previews/#interactive-previews). Entering selects the view and returns whether its mode started.
- `ctx.review.snapshot()` — captures stable file identities and every saved note from the authoritative shared ReviewStore.
- `ctx.selection` — where the review was pointing when the command fired.
- `ctx.navigation` — moves the review stream.
- `ctx.dialogs` — asks the user, below.
- `ctx.workspace` — reads reviewed files, and writes one back to the working tree with the user's consent, below.

```ts
hunk.registerCommand(
  { id: "show-selection", title: "Show the selected file", key: "ctrl+y" },
  (ctx) => {
    const { file, hunkIndex } = ctx.selection;
    if (!file) {
      ctx.notify("No file selected");
      return;
    }

    ctx.notify(hunkIndex === null ? file.path : `${file.path} — hunk ${hunkIndex + 1}`);
  },
);
```

`selection.file` is a frozen view, identical to a pane's `files` entries; it is `null` when filtering hides the selected file or when no files are visible. `selection.hunkIndex` is `null` whenever `file` is, or when the file has no hunks. `selection.currentLine` is the one-based `{ side, line }` source address carrying the current-line marker, or `null` when that marker is off or the review has not settled on a rendered line. It belongs to this file and hunk, uses Hunk's canonical new-side address for context rows, and can be passed directly to `navigation.revealLine`. The values are captured when the command fires, so an async handler keeps the selection it started from.

### Authoritative review snapshots

`ctx.review.snapshot()` returns a deeply immutable value, or `null` after the command's review generation expires. It contains the opaque producer `generation`, the shared store's `stateRevision`, every file in authoritative review/sidebar order, and every saved live or reviewer note. File records expose stable `fileKey`, transient navigation `runtimeId`, content identity, status, and paths. Note records preserve their complete old/new anchor and `active`, `stale`, or `orphaned` reconciliation status.

Drafts are not saved and are excluded. Static sidecar annotations that never entered ReviewStore remain on changeset file views rather than in the snapshot. Saved notes are ordered by live arrival and then reviewer creation, including orphaned notes an exporter may need to move into a summary.

For irreversible asynchronous work, capture once, prepare the request, then call `snapshot()` again and compare both `generation` and `stateRevision`. Revisions compare only within one generation. The [`review-snapshot-export` example](https://github.com/modem-dev/hunk/tree/main/examples/extensions/review-snapshot-export) demonstrates the complete JSON export and stale-work check. The [`review-note-navigator` example](https://github.com/modem-dev/hunk/tree/main/examples/extensions/review-note-navigator) combines the complete inventory and authoritative anchors with a selector dialog and guarded navigation to currently visible files.

`ctx.navigation.selectFile(fileId)`, `selectHunk(fileId, hunkIndex)`, and `revealLine(fileId, side, line)` route through the same guarded review controller as a pane's `actions` — the stream scrolls, selection updates, `selection_changed` fires. Unlike `selection` it is live: a handler that awaits a dialog and then navigates still works.

`revealLine` is the finest target: a hunk hundreds of lines tall has one anchor, so `selectHunk` can leave the line you meant pages below the viewport. `line` is 1-based on `side` as the patch numbers it, so a context line answers to either side's number. The revealed line lands a little below the viewport top — where every other Hunk reveal lands — and becomes the current line, pairing with a mark from `registerLineHighlighter`. A line no rendered row carries (inside a collapsed gap, absent from a partial patch, or with the current-line marker off) falls back to the hunk containing it; a line no hunk covers, a side outside `"old"`/`"new"`, and a line number that is not a positive whole number are refused with a warning naming the extension.

All built-ins listed in the [keybindings reference](https://github.com/modem-dev/hunk/blob/main/docs/keybindings.md) are public to command handlers. This includes the unbound `hunk.review.alignCurrentLineTop`, `hunk.review.alignCurrentLineCenter`, and `hunk.review.alignCurrentLineBottom` commands. `count` defaults to `1`, is capped at `10,000`, and scales relative row, viewport, horizontal, file, hunk, and annotated navigation in one host transition. Absolute and one-shot commands run once. Unknown, disabled, non-public, extension-owned, or stale commands return `false`. `isEnabled` also returns `false` for a malformed id; malformed `execute` ids, options, and counts throw into normal extension failure containment.

A handler may be async; a failure becomes a warning naming your extension.

### Asking the user

`ctx.dialogs` puts a question on screen and waits for the answer. Three methods, all return promises:

- `confirm({ title, body?, confirmLabel?, cancelLabel? })` → `true` or `false`
- `select({ title, options })` → the chosen string, or `null`
- `input({ title, placeholder?, initial? })` → the typed string, or `null`

```ts
hunk.registerCommand(
  { id: "reformat", title: "Reformat the selected file", key: "ctrl+r" },
  async (ctx) => {
    const file = ctx.selection.file;
    if (!file) {
      return;
    }

    const proceed = await ctx.dialogs.confirm({
      title: `Reformat ${file.path}?`,
      body: "The file is rewritten in place.",
      confirmLabel: "reformat",
    });

    ctx.notify(proceed ? `Reformatting ${file.path}` : "Left it alone");
  },
);
```

`select` fits acting on part of the selection — asking which hunk to jump to, then navigating there:

```ts
hunk.registerCommand({ id: "pick-hunk", title: "Pick a hunk", key: "ctrl+k" }, async (ctx) => {
  const file = ctx.selection.file;
  const hunks = file?.hunks ?? [];
  if (!file || hunks.length === 0) {
    ctx.notify("Nothing to pick from", "warning");
    return;
  }

  const labels = hunks.map((hunk) => hunk.header || `hunk ${hunk.index + 1}`);
  const picked = await ctx.dialogs.select({ title: "Which hunk?", options: labels });

  // `navigation` is live, so the jump is valid even after awaiting the dialog.
  if (picked !== null) {
    ctx.navigation.selectHunk(file.id, labels.indexOf(picked));
  }
});
```

Hunk draws the dialog; your text fills the title, body, and choices. Dialogs from installed extensions carry an `ext <your-id>` attribution line — the same marker `notify` toasts use — so a third-party prompt cannot present itself as Hunk asking. Hunk's own bundled extensions omit that redundant marker.

One dialog shows at a time; concurrent requests queue in call order, across extensions. Escape cancels (`false` or `null`), Enter accepts; confirm dialogs also answer to `y`/`n`, select dialogs to `↑`/`↓`, and everything is clickable. A session reload cancels open and queued dialogs, and a dialog pending at shutdown resolves its cancel value.

### Workspace documents

`ctx.workspace` reads full documents from the current review and writes eligible working-tree files.

| Method                                 | Result                                            |
| -------------------------------------- | ------------------------------------------------- |
| `readDocument(fileId, "old" \| "new")` | Reviewed source text or `null`                    |
| `canWriteDocument(fileId)`             | Whether review policy allows a write              |
| `writeDocument({ fileId, text })`      | `{ ok: true }` or `{ ok: false, reason, detail }` |

```ts
const file = ctx.selection.file;
if (file && ctx.workspace.canWriteDocument(file.id)) {
  const text = await ctx.workspace.readDocument(file.id, "new");
  if (text !== null) {
    await ctx.workspace.writeDocument({ fileId: file.id, text: transform(text) });
  }
}
```

Reads return the source represented by the review, including historical content in revision and stash reviews. Missing, unreadable, or oversized sources return `null`; reads never prompt.

Writes require a reloadable, unstaged working-tree review and a writable reviewed-file id. Hunk verifies the target, asks for attributed consent, verifies it again, writes it, and reloads the review. Other review kinds and deleted, binary, oversized, missing, symlinked, or root-escaping targets return `unavailable`. Cancellation returns `cancelled`; an attempted write failure returns `failed` with a displayable `detail`.

`canWriteDocument` does not inspect the filesystem, so `writeDocument` can still refuse a changed target. See the [full workspace guide](https://github.com/modem-dev/hunk/blob/main/docs/extensions.md#workspace-documents) for lifecycle and error details.

## `hunk.on(event, handler)`

Subscribe to a lifecycle or UI event. Handlers may be async; Hunk never blocks the UI waiting for one. Every handler receives `ctx.panes`, live `ctx.navigation`, and attributed `ctx.dialogs` alongside `cwd` and `notify`, so a `startup` handler can present one focused welcome dialog and navigate to its first example without a keypress. `ctx.sidebars` is deprecated. Controls retained across a review or extension-registry replacement expire instead of controlling the replacement UI; workspace reads and writes that have not started return `null`/`unavailable`. Once a consented filesystem write starts, it reports its actual outcome, graceful shutdown waits for it, and success reconciles the review then active.

| Event                  | Payload                 | When                                                     |
| ---------------------- | ----------------------- | -------------------------------------------------------- |
| `startup`              | `{ cwd }`               | once, after the app mounts with its first changeset      |
| `changeset_loaded`     | `{ changeset }`         | first load and every reload                              |
| `command_executed`     | `{ commandId }`         | after a named command dispatches in this terminal host   |
| `selection_changed`    | `{ fileId, hunkIndex }` | when the review selection settles (debounced ~150ms)     |
| `file_viewed`          | `{ file, hunkIndex }`   | when selection settles on a file or a reload replaces it |
| `filter_changed`       | `{ filter }`            | whenever the file-filter query changes                   |
| `theme_changed`        | `{ themeId }`           | when the user commits a new theme                        |
| `layout_changed`       | `{ mode, layout }`      | mode or responsive split/stack layout changes            |
| `watch_reload_pending` | `{}`                    | watcher observed a change before its reload check        |
| `note_created`         | `{ note }`              | a user saves an inline review note                       |
| `note_edited`          | `{ note }`              | an in-progress inline note's body changes                |
| `session_reload`       | `{ changeset, reason }` | on every session reload                                  |
| `shutdown`             | `{}`                    | on exit, best-effort within a short timeout              |

- A newly mounted instance receives `startup` before its first `changeset_loaded`; reloads deliver `changeset_loaded` before `session_reload` after the matching review commits.
- `selection_changed` is trailing-debounced: holding `[`/`]` retargets many times a second, and handlers only care where the user landed. `fileId` and `hunkIndex` are `null` when nothing is selected.
- `command_executed` reports stable command ids after terminal dispatch from a key, menu, or `ctx.commands.execute`. Detached async extension work may still be running; the event observes the accepted action rather than promise settlement. It follows remapped keys; browser/session review intents and widget-owned Escape, Enter, note-editor Ctrl-S, and F10 menu navigation are not terminal commands.
- `session_reload`'s `reason` is `"watch"`, `"daemon"` (an agent command through the session broker), or `"manual"`.
- `note_created` and `note_edited` cover notes authored in Hunk's own UI this session. Agent session comments do not emit them, and a reload may remap or drop notes. Use them for incremental reactions; use `ctx.review.snapshot()` when a command needs the complete current saved-note record.
- `shutdown` handlers get 250ms before Hunk exits anyway; treat it as best-effort flushing. UI authority has already been revoked, so shutdown is for releasing extension-owned resources rather than navigation or dialogs.

## `hunk.events`

A small bus shared by every loaded extension, for coordinating without coupling through global state. Namespace event names with your extension id. Delivery is fire-and-forget; events emitted while factories are still loading are queued until every extension has subscribed.

```ts
import type { HunkExtensionAPI } from "hunkdiff/extension";

export default function (hunk: HunkExtensionAPI) {
  hunk.events.on<{ fileCount: number }>("summary:ready", (payload, ctx) => {
    if (payload.fileCount > 100) ctx.panes.open("summary");
  });

  hunk.on("changeset_loaded", ({ changeset }, ctx) => {
    hunk.events.emit("summary:ready", { fileCount: changeset.files.length });
    ctx.panes.open("summary");
  });
}
```

Bus payloads are shallow-frozen copies when they are objects. Keep nested data immutable if multiple extensions will read it.

## `hunk.config`

Your extension's own `[extension.<id>]` config table, as a plain object. Hunk does not interpret the keys, and repo config overrides user config key by key.

**Treat these values as untrusted.** A repository under review can set or override the table for an extension you installed globally (deliberate — team-level tuning of a shared extension), so never use `hunk.config` for exec-adjacent decisions such as binary paths, shell commands, or module loading. Validate those against something the user controls.

```toml
# ~/.config/hunk/config.toml
[extension.collapse-generated]
patterns = ["*.lock", "dist/**"]
```

```ts
const patterns = (hunk.config.patterns as string[] | undefined) ?? ["*.lock"];
```

## `ctx.notify(message, type?)`

Every handler and transform receives a context with `cwd` and `notify`; event and bus handlers add `panes` and `events.emit`, command handlers add `commands`, `panes`, `fileViews`, `selection`, `navigation`, and `dialogs`. `notify` shows one transient line at the bottom of the app; `type` is `"info"` (default), `"warning"`, or `"error"`. Messages raised before the UI mounts are buffered, so a `startup` handler can notify safely.

## `hunk.log(message)`

Record a diagnostic line. Logs are collected per extension rather than written to the terminal, because the TUI owns the screen.

## Not contributable yet

Menu entries, standalone keybindings (chords without a command — `registerCommand` commands are already user-remappable), custom note renderers, session commands, and CLI subcommands. See [`docs/extension-system-exploration.md`](https://github.com/modem-dev/hunk/blob/main/docs/extension-system-exploration.md) for the design and phasing.
