---
title: Extension API
description: Register themes, file previews, transforms, commands, dialogs, and events through the extension API object.
---

The extension factory receives one API object. Registration calls are only valid while the factory is running; Hunk seals the object afterwards so a deferred callback cannot mutate the registry mid-session. This page indexes the whole object; larger registration calls are documented in depth on their own pages and summarized in place below.

## `hunk.apiVersion`

The API generation this Hunk speaks (currently `2`). Branch on it if you want one file to support several Hunk versions. Version 2 adds the experimental file-view contract and its command controls.

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

## `hunk.registerFileLanguage(extension, language)`

Map a file extension to a syntax-highlighting language. The extension may be written with or without a leading dot and is lowercased.

```ts
hunk.registerFileLanguage(".zig", "zig");
hunk.registerFileLanguage("bzl", "python");
```

Later registrations win. Hunk's own `.mts` and `.cts` mappings cannot be overridden.

## `hunk.registerVcsAdapter(adapter)`

Contribute an additional version-control backend — the same call Hunk's own bundled Git, Jujutsu, and Sapling backends make. An adapter declares `detect`, its `operations` (`working-tree-diff`, `revision-show`, `stash-show`), and optionally detection priority, watch support, exact file sources, extra files, and rich user-fixable failures.

Full contract: [VCS adapters](/docs/extend/vcs-adapters/).

## `hunk.registerSidebarView(view)`

Contribute a sidebar view — your own React component, rendered inside Hunk's OpenTUI tree beside (or in place of) the built-in file navigation. Views receive live review props, guarded navigation actions, the user's resolved keybindings, and a scrollbox ref contract for selection-following and windowing.

Full contract: [Custom sidebars](/docs/extend/custom-sidebars/).

## `hunk.registerFileView(view)`

Contribute an opt-in alternate presentation for matching files. A view receives the public file and hunk model, typed change ranges, terminal width, cancellation, and lazy exact-source reads. It returns deterministic symbolic rows, optional fixed-height React/OpenTUI row painters, source bindings for inline notes, and positional hunk extents.

Raw diff remains the default and fallback. Hunk continues to own review-stream geometry, scrolling, windowing, hunk navigation, selection, and note rendering.

Full contract and examples: [File previews](/docs/extend/file-previews/).

## `hunk.transformChangeset(fn)`

Rewrite the loaded changeset before it reaches the review UI. Transforms run in registration order, each seeing the previous one's output, on first load and on every reload.

```ts
hunk.transformChangeset((changeset) => ({
  ...changeset,
  files: changeset.files.filter((file) => !file.path.endsWith(".lock")),
}));
```

The function may be async. Filtering and reordering `files` is fully supported — the sidebar and the review stream follow whatever you return.

Each file carries an opaque `metadata` field — the parsed diff the renderer draws from — so pass it through untouched; spreading a file preserves it. Returns are validated: a transform that throws or returns something the review UI cannot draw is skipped, and the previous changeset carries forward.

You never need `metadata` to know a file's hunks: the read-only views Hunk hands outward (event payloads, sidebar props, a command's selection) carry a `hunks` list of public summaries — `index`, the `@@` header, and the inclusive old/new line spans, in render order. Like `changeType`, it is derived at that boundary; a transform neither receives nor produces it.

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

Key chords join `ctrl`, `alt`/`option`, `cmd`/`meta`, and `shift` with `+` around a base key — a character (`"y"`), an uppercase letter for its shifted form (`"G"`), or a named key (`"f2"`, `"pageup"`). For a shifted symbol or digit, bind the character shift produces (`"!"`, not `"shift+1"`). `key` also takes a list of chords; omit it to register a command with no binding. A chord already owned by a built-in or an earlier-loaded extension stays with its owner.

Declared keys are defaults: users remap commands by id in their `[keybindings]` table — yours is `"<extensionId>.<commandId>"`. See [`docs/keybindings.md`](https://github.com/modem-dev/hunk/blob/main/docs/keybindings.md).

Registered commands are also listed in the menu bar's **Extensions** menu under their `title`, showing whichever key they currently answer to — a command with no binding is still reachable with the mouse.

The handler fires when the key is pressed outside modal UI (dialogs, menus, and focused text inputs own their keys). It receives the standard context plus:

- `ctx.sidebars.open(viewId)` / `close(viewId)` / `toggle(viewId)` / `isOpen(viewId)` — a bare id names your own view, `"files"` the built-in file navigation, `"<extensionId>:<viewId>"` any registered view. Opening also reveals a hidden sidebar area.
- `ctx.fileViews.select(viewId)` / `toggle(viewId)` / `isActive(viewId)` — controls a matching [file preview](/docs/extend/file-previews/) for the current file; `select(null)` restores raw diff.
- `ctx.fileViews.refresh(viewId, options?)` — marks that view's prepared layouts stale so a stateful view re-derives; every file presenting it re-lays out, keeping its current rows visible until the replacement resolves. Pass `{ fileId }` to scope the invalidation to one reviewed file's presentation of the view.
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

`selection.file` is a frozen view, identical to a sidebar's `files` entries; it is `null` only when no files are visible. `selection.hunkIndex` is `null` whenever `file` is, or when the file has no hunks. The values are captured when the command fires, so an async handler keeps the selection it started from.

`ctx.navigation.selectFile(fileId)` and `selectHunk(fileId, hunkIndex)` route through the same guarded review controller as a sidebar's `actions` — the stream scrolls, selection updates, `selection_changed` fires. Unlike `selection` it is live: a handler that awaits a dialog and then navigates still works.

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

Hunk draws the dialog; your text fills the title, body, and choices, and the frame carries an `ext <your-id>` attribution line — the same marker `notify` toasts use — so a prompt cannot present itself as Hunk asking.

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

Subscribe to a lifecycle or UI event. Handlers may be async; Hunk never blocks the UI waiting for one. Every handler receives `ctx.sidebars` alongside `cwd` and `notify`, so a `changeset_loaded` handler can reveal its extension's sidebar without a keypress.

| Event                  | Payload                 | When                                                     |
| ---------------------- | ----------------------- | -------------------------------------------------------- |
| `startup`              | `{ cwd }`               | once, after the app mounts with its first changeset      |
| `changeset_loaded`     | `{ changeset }`         | first load and every reload                              |
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

- `selection_changed` is trailing-debounced: holding `[`/`]` retargets many times a second, and handlers only care where the user landed. `fileId` and `hunkIndex` are `null` when nothing is selected.
- `session_reload`'s `reason` is `"watch"`, `"daemon"` (an agent command through the session broker), or `"manual"`.
- `note_created` and `note_edited` cover notes authored in Hunk's own UI this session. Agent session comments do not emit them, and a reload may remap or drop notes — an accumulated list is not a complete review record.
- `shutdown` handlers get 250ms before Hunk exits anyway; treat it as best-effort flushing.

## `hunk.events`

A small bus shared by every loaded extension, for coordinating without coupling through global state. Namespace event names with your extension id. Delivery is fire-and-forget; events emitted while factories are still loading are queued until every extension has subscribed.

```ts
import type { HunkExtensionAPI } from "hunkdiff/extension";

export default function (hunk: HunkExtensionAPI) {
  hunk.events.on<{ fileCount: number }>("summary:ready", (payload, ctx) => {
    if (payload.fileCount > 100) ctx.sidebars.open("summary");
  });

  hunk.on("changeset_loaded", ({ changeset }, ctx) => {
    hunk.events.emit("summary:ready", { fileCount: changeset.files.length });
    ctx.sidebars.open("summary");
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

Every handler and transform receives a context with `cwd` and `notify`; event and bus handlers add `sidebars` and `events.emit`, command handlers add `sidebars`, `fileViews`, `selection`, `navigation`, and `dialogs`. `notify` shows one transient line at the bottom of the app; `type` is `"info"` (default), `"warning"`, or `"error"`. Messages raised before the UI mounts are buffered, so a `startup` handler can notify safely.

## `hunk.log(message)`

Record a diagnostic line. Logs are collected per extension rather than written to the terminal, because the TUI owns the screen.

## Not contributable yet

Menu entries, standalone keybindings (chords without a command — `registerCommand` commands are already user-remappable), custom note renderers, session commands, and CLI subcommands. See [`docs/extension-system-exploration.md`](https://github.com/modem-dev/hunk/blob/main/docs/extension-system-exploration.md) for the design and phasing.
