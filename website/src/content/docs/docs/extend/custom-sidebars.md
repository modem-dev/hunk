---
title: Custom sidebars
description: Render your own React sidebar view inside Hunk, with selection, scrolling, and event-driven state.
---

`hunk.registerSidebarView(view)` contributes a sidebar view — your own React component, rendered inside Hunk's OpenTUI tree. Registration is additive: your view exists beside the built-in file navigation, on either side of the review stream, and any number of views can be open at once. Pair it with [`registerCommand`](/docs/extend/extension-api/#hunkregistercommandcommand-handler) so a key opens it:

```tsx
// ~/.config/hunk/extensions/flat-sidebar.tsx
import { useMemo } from "react";
import type { ExtensionSidebarViewProps, HunkExtensionAPI } from "hunkdiff/extension";

function FlatSidebar({ files, selectedFileId, theme, actions }: ExtensionSidebarViewProps) {
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
  hunk.registerSidebarView({
    id: "flat",
    title: "Flat files",
    placement: "right",
    component: FlatSidebar,
  });
  hunk.registerCommand(
    { id: "toggle-flat", title: "Toggle flat sidebar", key: "ctrl+f" },
    (ctx) => {
      ctx.sidebars.toggle("flat");
    },
  );
}
```

Beyond `id` and `component`, a view may declare a `title` (for diagnostics and future menu listings), a `placement` of `"left"` (default) or `"right"`, `defaultOpen: true` to start open, or `replacesDefault: true` to start open _in place of_ the built-in file navigation — which stays available, just closed, so a command can reopen it.

Import `react` normally — Hunk serves its own React instance to extension files at import time, so hooks, context, and JSX all run on the reconciler drawing the rest of the app. **Never bundle or vendor a copy of React into an extension**: a second React means a second hooks dispatcher, and the component will fail to render. OpenTUI elements (`box`, `text`, `scrollbox`, ...) are plain intrinsic elements and need no import.

## Props

The component receives fresh props as the app changes:

| Prop                | What it is                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `files`             | the visible reviewed files, review-stream order, filtered, frozen views (each carries `changeType`, `statsTruncated`, and `hunks` summaries beside the usual file fields) |
| `selectedFileId`    | the selected file, or `null`                                                                                                                                              |
| `selectedHunkIndex` | the selected hunk within that file, or `null`                                                                                                                             |
| `width`             | terminal columns the sidebar pane occupies                                                                                                                                |
| `theme`             | hex color tokens from the active theme, updated on theme switch                                                                                                           |
| `keybindings`       | the current command bindings, resolved from defaults and the user's `[keybindings]` table                                                                                 |
| `actions`           | navigation the sidebar may trigger                                                                                                                                        |

`actions.selectFile(fileId)` and `actions.selectHunk(fileId, hunkIndex)` route through the same review controller as the built-in sidebar and the keyboard shortcuts, so the review stream scrolls, selection updates, and the `selection_changed` event fires exactly as if the user had clicked a built-in row. `actions.notify(message, type?)` shows a toast attributed to your extension. An action given a file id that is not currently visible is refused with a warning rather than corrupting the selection.

The three hunk surfaces line up by design: each file's `hunks` lists public `ExtensionDiffHunk` summaries (`index`, the `@@` header, inclusive old/new line spans) in render order, `selectedHunkIndex` reports the same index, and `actions.selectHunk(fileId, hunkIndex)` accepts it. That is everything a hunk checklist, a per-hunk progress view, or an agent-annotation navigator needs — match an annotation's `oldRange`/`newRange` against the summaries' spans to find its hunk — without touching the opaque `metadata`.

## Keys inside a component

A component that owns a key event should ask the injected `keybindings` manager about a **command id**, rather than hard-coding the command's default chord. This keeps local component behavior synchronized with the user's remaps and unbindings:

```ts
import type { ExtensionKeyEvent, ExtensionSidebarViewProps } from "hunkdiff/extension";

export function handleSidebarKey(props: ExtensionSidebarViewProps, key: ExtensionKeyEvent) {
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

Hunk keeps owning pane arrangement — widths, resize dividers, responsive show/hide, and dropping panes that no longer fit a narrow terminal — and your component fills the pane it is given. A component that throws while rendering costs you the pane, not the user the session: the failure is reported as a toast naming your extension, the pane closes, and the built-in file navigation reopens if nothing else is showing.

Props carry the pane's `width` but not its height: the pane is a flex cell, so give your root element `height="100%"` and let layout size it. Everything else about scrolling — pane viewport height, scroll position, keeping a row visible — goes through the `<scrollbox>` itself, via a plain React ref. Hunk serves its own `@opentui/core` to extension files, so the renderable a ref hands you is the very instance the host renders with.

## Scrolling: the scrollbox ref contract

The one behavior a list sidebar always ends up needing is following the selection. Give your rows stable `id` props, hold a ref to the scrollbox, and scroll the selected row into view from an effect:

```tsx
import { useEffect, useRef } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { ExtensionSidebarViewProps } from "hunkdiff/extension";

function HunkList({
  files,
  selectedFileId,
  selectedHunkIndex,
  theme,
  actions,
}: ExtensionSidebarViewProps) {
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

The ref surface this recipe stands on is the exact one the built-in sidebar runs on:

- **`scrollChildIntoView(id)`** scrolls the descendant with that `id` prop into view.
- **`scrollTop`** and **`viewport.height`** read the current scroll offset and the pane's viewport rows — the pane-height number the props do not carry. A read before the first layout pass reports `0`, so viewport-dependent code belongs behind the events below rather than a bare mount effect.
- **`verticalScrollBar.on("change", handler)`**, **`viewport.on("layout-changed", handler)`**, and **`viewport.on("resized", handler)`** report scrolling and pane resizes; unsubscribe with the matching `.off` in your effect's cleanup.

That is enough to window a long list yourself: the built-in sidebar renders only the rows near the viewport, plus spacer boxes sized from those same reads (its render-window helper is host code, but nothing it computes needs anything beyond this surface — `useTerminalDimensions` from `@opentui/react` serves as its pre-first-layout viewport estimate).

One honest caveat: this contract rides on OpenTUI's renderable API, served at whatever version Hunk pins — a wider surface than `hunkdiff/extension` itself. The built-in sidebar exercising the exact same calls is the compatibility guarantee: a change that breaks your scroll code breaks Hunk's own sidebar first. Still, keep scroll handling small and behind your own helpers.

The built-in sidebar is itself a bundled extension (`src/extensions/default/ui/sidebar/` in the Hunk repository): it registers through this exact call, its component consumes exactly the props documented above, and its windowing and selection follow run on exactly the ref contract above — so it doubles as the reference implementation for everything a third-party sidebar can build, from grouping and stat badges down to scroll behavior.

## Sidebar state from events

Lifecycle handlers run outside React, but a sidebar component only rerenders when React sees a change. The recipe that connects them is a module-local store read through `useSyncExternalStore`: the event handler updates the store, and any mounted component subscribed to it rerenders — while the store keeps accumulating even when the pane is closed.

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
  hunk.registerSidebarView({ id: "progress", component: ViewedCount });
}
```

Snapshots must be immutable — replace the set instead of mutating it, so `useSyncExternalStore` can compare references. Storing state in a hook inside the component instead would lose it every time the pane closes and unmounts.
