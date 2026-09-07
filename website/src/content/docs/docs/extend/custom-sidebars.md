---
title: Custom panes
description: Render React panes around Hunk's review stream.
---

`hunk.registerPane(pane)` renders a React component on the left, right, top, or bottom of the review. Pair it with [`registerCommand`](/docs/extend/extension-api/#hunkregistercommandcommand-handler) so a key opens it:

```tsx
// ~/.config/hunk/extensions/flat-sidebar.tsx
import { useMemo } from "react";
import type { ExtensionPaneProps, HunkExtensionAPI } from "hunkdiff/extension";

function FlatPane({ files, selectedFileId, theme, actions }: ExtensionPaneProps) {
  const ordered = useMemo(() => [...files].sort((a, b) => a.path.localeCompare(b.path)), [files]);

  return (
    <scrollbox scrollY={true} width="100%" height="100%">
      {ordered.map((file) => (
        <text
          key={file.id}
          content={` ${file.path}  +${file.stats.additions} -${file.stats.deletions}`}
          style={{
            fg: file.id === selectedFileId ? theme.accent : theme.text,
            bg: theme.panel,
          }}
          onMouseDown={() => actions.selectFile(file.id)}
        />
      ))}
    </scrollbox>
  );
}

export default function (hunk: HunkExtensionAPI) {
  hunk.registerPane({
    id: "flat",
    title: "Flat files",
    placement: "right",
    component: FlatPane,
  });
  hunk.registerCommand({ id: "toggle-flat", title: "Toggle flat pane", key: "ctrl+f" }, (ctx) => {
    ctx.panes.toggle("flat");
  });
}
```

`placement` defaults to `"left"`. Left/right panes use `width`; top/bottom panes use `height`. Both accept `{ preferred, min?, max?, fraction? }`, defaulting to `{ preferred: 34, min: 22 }` columns or `{ preferred: 8, min: 3 }` rows. Equal bounds make a fixed pane.

`fraction` opts into live responsive sizing until the user drags the divider. It must be greater than `0` and at most `1`; Hunk rounds that fraction of the full host body width or height to a terminal cell, then applies `min`, `max`, and the space required by the review. `preferred` remains the fixed-cell target when `fraction` is omitted. A divider drag establishes a session-local cell override: later terminal shrink may clamp it temporarily, and expanding restores it. Panes without `fraction` retain their fixed preferred startup size. Folder extensions that use `fraction` should declare `"hunk": { "apiVersion": 12 }` in their manifest.

Use `defaultOpen` to open a pane initially, `replaces: "hunk:files"` to replace it (and override `defaultOpen`), or `available(context)` to hide it conditionally. One pane may replace each named target; the first registration owns that slot and later claims are skipped with a warning. `replaces` may also name another pane by its fully qualified `"<extensionId>:<paneId>"` key, and Hunk follows those replacement chains. Both `available(context)` and the mounted component receive `review`: immutable delegated review metadata, or `null` for ordinary reviews. Hunk's bundled `hunk:review-info` top pane uses it for change requests and consumes no rows when absent. Pane extensions that read `review` should declare `"hunk": { "apiVersion": 17 }` in their manifest so older Hunk versions refuse them cleanly instead of mounting with an incomplete prop contract.

`onActivate()` observes a primary mouse press anywhere in the pane's content, including content nested in a `<scrollbox>`. Use it to focus an extension-owned editor or update pane-local active state without adding mouse handlers to every row. Hunk does not stop propagation or prevent the press, so extension-local mouse behavior can continue. Other mouse buttons do not activate the pane. A thrown or rejected callback is contained and reported as an attributed warning.

`hunk:files` is a named role, not a left-edge location. The `hunk.view.toggleFilesPane` command (`s` by default) and **View → Files pane** follow the resolved owner of that slot on any edge and leave independently registered panes alone. User remaps and unbindings apply to that command normally; the former `hunk.view.toggleSidebar` id remains a compatibility alias. `ctx.panes.toggle("hunk:files")`, by contrast, addresses the literal built-in pane; use `ctx.commands.execute("hunk.view.toggleFilesPane")` when an extension wants the role-aware slot behavior.

Set `currentLine: true` to receive Hunk's selected-row painter plus the `{ side, line }` source address of the current-line marker — the same address command handlers see on `ctx.selection.currentLine`. The external [Hunk Lens](https://github.com/modem-dev/hunk-lens) extension uses the painter; a blame or diagnostic pane can use the address. It is not bundled with Hunk. Install the lens with `hunk extension install modem-dev/hunk-lens`.

API-v3 sidebar names remain as deprecated aliases.

Import `react` normally — Hunk serves its own React instance to extension files at import time, so hooks, context, and JSX all run on the reconciler drawing the rest of the app. **Never bundle or vendor a copy of React into an extension**: a second React means a second hooks dispatcher, and the component will fail to render. OpenTUI elements (`box`, `text`, `scrollbox`, ...) are plain intrinsic elements and need no import.

## Props

The component receives fresh props as the app changes:

| Prop                | What it is                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `review`            | immutable delegated review metadata (`change-request`, `commit`, or `comparison`), or `null` for ordinary reviews                                                         |
| `files`             | the visible reviewed files, review-stream order, filtered, frozen views (each carries `changeType`, `statsTruncated`, and `hunks` summaries beside the usual file fields) |
| `selectedFileId`    | the selected file, or `null`                                                                                                                                              |
| `selectedHunkIndex` | the selected hunk within that file, or `null`                                                                                                                             |
| `placement`         | the accepted terminal edge                                                                                                                                                |
| `width`             | exact terminal columns in the host-owned rectangle                                                                                                                        |
| `height`            | exact terminal rows in the host-owned rectangle                                                                                                                           |
| `currentLine`       | selected-row painter plus `{ side, line }` when the registration opts in, otherwise `null`                                                                                |
| `theme`             | hex color tokens from the active theme, updated on theme switch                                                                                                           |
| `keybindings`       | the current command bindings, resolved from defaults and the user's `[keybindings]` table                                                                                 |
| `actions`           | guarded navigation and notifications the pane may trigger                                                                                                                 |

`actions.selectFile(fileId)` and `actions.selectHunk(fileId, hunkIndex)` route through the same review controller as the built-in files pane and the keyboard shortcuts, so the review stream scrolls, selection updates, and the `selection_changed` event fires exactly as if the user had clicked a built-in row. `actions.notify(message, type?)` shows a toast attributed to your extension. An action given a file id that is not currently visible is refused with a warning rather than corrupting the selection.

The three hunk surfaces line up by design: each file's `hunks` lists public `ExtensionDiffHunk` summaries (`index`, the `@@` header, inclusive old/new line spans) in render order, `selectedHunkIndex` reports the same index, and `actions.selectHunk(fileId, hunkIndex)` accepts it. That is everything a hunk checklist, a per-hunk progress view, or an agent-annotation navigator needs — match an annotation's `oldRange`/`newRange` against the summaries' spans to find its hunk — without touching the opaque `metadata`.

## Keys inside a component

A component that owns a key event should ask the injected `keybindings` manager about a **command id**, rather than hard-coding the command's default chord. This keeps local component behavior synchronized with the user's remaps and unbindings:

```ts
import type { ExtensionKeyEvent, ExtensionPaneProps } from "hunkdiff/extension";

export function handlePaneKey(props: ExtensionPaneProps, key: ExtensionKeyEvent) {
  const nextFile = props.files[1];
  if (nextFile && props.keybindings.matches(key, "hunk.review.nextFile")) {
    // The user may have remapped this from `.` to another chord.
    props.actions.selectFile(nextFile.id);
  }
}
```

`keybindings.getKeys(commandId)` returns the current chord list for a label or hint; unknown and unbound commands return an empty list. `matches(key, commandId)` returns `false` for those commands too. The manager includes both Hunk commands and extension commands under their documented ids, and its key event argument is structural — OpenTUI's `KeyEvent` works directly.

`matchesKey`, `parseKeyChord`, and `matchesKeyChord` remain exported for extension-local keys that intentionally are not commands. Prefer a named command whenever a shortcut should be user-remappable.

## The pane is Hunk's, the content is yours

Hunk owns pane geometry, dividers, and responsive omission. Render failures are contained to the pane; a failed files-pane replacement restores file navigation.

Props carry the pane's exact `width` and `height`. Use a `<scrollbox>` ref for scroll position and selection following; Hunk serves the matching `@opentui/core` instance.

## Scrolling: the scrollbox ref contract

The one behavior a list pane always ends up needing is following the selection. Give your rows stable `id` props, hold a ref to the scrollbox, and scroll the selected row into view from an effect:

```tsx
import { useEffect, useRef } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { ExtensionPaneProps } from "hunkdiff/extension";

function HunkList({
  files,
  selectedFileId,
  selectedHunkIndex,
  theme,
  actions,
}: ExtensionPaneProps) {
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);

  // Follow policy is deliberately yours: the host never scrolls a pane it
  // cannot see into, so decide here when (and whether) to follow.
  useEffect(() => {
    if (selectedFileId !== null) {
      scrollRef.current?.scrollChildIntoView(`row-${selectedFileId}-${selectedHunkIndex ?? 0}`);
    }
  }, [selectedFileId, selectedHunkIndex]);

  return (
    <scrollbox ref={scrollRef} width="100%" height="100%" scrollY={true} focused={false}>
      {files.flatMap((file) =>
        (file.hunks ?? []).map((hunk) => {
          const selected = file.id === selectedFileId && hunk.index === selectedHunkIndex;
          return (
            <box
              key={`${file.id}:${hunk.index}`}
              id={`row-${file.id}-${hunk.index}`}
              style={{ width: "100%", height: 1 }}
              onMouseUp={() => actions.selectHunk(file.id, hunk.index)}
            >
              <text
                content={` ${file.path}  ${hunk.header}`}
                style={{ fg: selected ? theme.accent : theme.text }}
              />
            </box>
          );
        }),
      )}
    </scrollbox>
  );
}
```

The ref surface this recipe stands on is the exact one the built-in files pane runs on:

- **`scrollChildIntoView(id)`** scrolls the descendant with that `id` prop into view.
- **`scrollTop`** and **`viewport.height`** read the current scroll offset and the scrollbox's live viewport rows. A read before the first layout pass reports `0`, so viewport-dependent code belongs behind the events below rather than a bare mount effect.
- **`verticalScrollBar.on("change", handler)`**, **`viewport.on("layout-changed", handler)`**, and **`viewport.on("resized", handler)`** report scrolling and pane resizes; unsubscribe with the matching `.off` in your effect's cleanup.

That is enough to window a long list yourself: the built-in files pane renders only the rows near the viewport, plus spacer boxes sized from those same reads (its render-window helper is host code, but nothing it computes needs anything beyond this surface — `useTerminalDimensions` from `@opentui/react` serves as its pre-first-layout viewport estimate).

One honest caveat: this contract rides on OpenTUI's renderable API, served at whatever version Hunk pins — a wider surface than `hunkdiff/extension` itself. The built-in files pane exercising the exact same calls is the compatibility guarantee: a change that breaks your scroll code breaks Hunk's own files pane first. Still, keep scroll handling small and behind your own helpers.

The built-in files pane is itself a bundled extension (`packages/hunk/src/extensions/default/ui/sidebar/` in the Hunk repository): it registers through this exact call, its component consumes exactly the props documented above, and its windowing and selection follow run on exactly the ref contract above — so it doubles as the reference implementation for everything a third-party pane can build, from grouping and stat badges down to scroll behavior.

## Pane state from events

Lifecycle handlers run outside React, but a pane component only rerenders when React sees a change. The recipe that connects them is a module-local store read through `useSyncExternalStore`: the event handler updates the store, and any mounted component subscribed to it rerenders — while the store keeps accumulating even when the pane is closed.

```tsx
import { useSyncExternalStore } from "react";
import type { HunkExtensionAPI } from "hunkdiff/extension";

let viewedPaths: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function markViewed(path: string) {
  if (viewedPaths.has(path)) return;
  viewedPaths = new Set(viewedPaths).add(path); // new reference, so React sees the change
  for (const listener of listeners) listener();
}

function useViewedPaths() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => viewedPaths,
  );
}

function ViewedCount() {
  const viewed = useViewedPaths();
  return <text content={`${viewed.size} files viewed`} />;
}

export default function (hunk: HunkExtensionAPI) {
  hunk.on("file_viewed", ({ file }) => markViewed(file.path));
  hunk.registerPane({ id: "progress", component: ViewedCount });
}
```

Snapshots must be immutable — replace the set instead of mutating it, so `useSyncExternalStore` can compare references. Storing state in a hook inside the component instead would lose it every time the pane closes and unmounts.
