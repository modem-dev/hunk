---
title: File previews
description: Add opt-in file presentations that keep Hunk's review navigation, scrolling, and inline notes.
---

`hunk.registerFileView(view)` lets an extension offer a different way to read a changed file. A Markdown extension can render headings and lists, a package extension can summarize dependency changes, and a CSS extension can put color swatches beside changed values.

A preview is still part of Hunk's normal review stream. Hunk keeps control of file ordering, measurement, scrolling, windowing, hunk navigation, selection, and inline notes. The extension describes deterministic rows; it does not replace the review pane.

The base file-view API is experimental and requires extension API version 2. Host-owned syntax paint for file-view code documents requires API version 24.

## What users see

Raw diff is always the default. Installing an extension does not silently replace any files.

When a registered view matches the selected file, Hunk adds it under **View → File presentation**. The user can choose a presentation for each file independently, so one review may contain custom previews and ordinary Pierre diffs together.

After choosing a preview, **View → Apply “…” to all matching files** selects it for every matching file in the changeset, including files hidden by the current filter. Files that do not match keep their existing presentation.

An extension command can also select or toggle its view for the current file:

```ts
hunk.registerCommand({ id: "toggle-preview", title: "Toggle preview", key: "f8" }, (ctx) => {
  ctx.fileViews.toggle("preview");
});
```

`ctx.fileViews.select("preview")` selects a view, `select(null)` returns to raw diff, and `isActive("preview")` reports the current selection. A bare id names the calling extension's view; `"other-extension:preview"` addresses another registered view. These controls intentionally target only the current file; applying a view across the changeset remains a host-owned View-menu action.

`ctx.fileViews.refresh("preview")` invalidates that view's prepared layouts. Hunk treats `layout` as a pure derivation of `(file, width)` and reuses its result until one of those changes, so a view holding its own state — a fold, a toggled overlay — flips that state and then asks for the re-derivation. Refresh defaults to view-wide: every file presenting the view re-runs `matches` and `layout`, while files on raw diff or another view do no work. The rows already on screen stay visible until their replacement resolves, so a refresh never flashes back to raw diff. When the state that changed belongs to one file — a fold, a per-file edit buffer — pass `refresh("preview", { fileId })` so only that file re-lays out and the other presenting files keep their prepared rows. A `fileId` no reviewed file carries invalidates nothing.

## Register a view

A view has an id, a title, a cheap file matcher, and a layout function:

```ts
import type { HunkExtensionAPI } from "hunkdiff/extension";

export default function (hunk: HunkExtensionAPI) {
  hunk.registerFileView({
    id: "preview",
    title: "Line preview",
    matches: (file) => file.path.endsWith(".md"),
    async layout(input) {
      const document = await input.readDocument("new");
      if (document === null || document === "") return null;

      const lines = (document.endsWith("\n") ? document.slice(0, -1) : document).split("\n");
      const hunkRows: Array<{ startRow: number; endRow: number }> = [];

      for (const hunk of input.file.hunks ?? []) {
        const [start, end] = hunk.newRange ?? [0, 0];
        // A missing or invalid new-side range cannot be positioned in this preview.
        if (start < 1 || end < start) return null;
        hunkRows.push({
          startRow: Math.min(lines.length - 1, start - 1),
          endRow: Math.min(lines.length - 1, end - 1),
        });
      }

      return {
        rows: lines.map((text, index) => ({
          id: `line:${index + 1}`,
          spans: [{ text: text || " " }],
        })),
        hunkRows,
      };
    },
  });
}
```

Return `null` whenever the view cannot safely present a file. Hunk will keep or restore the raw diff. This smallest example deliberately omits source bindings; add them only to rows owned by exactly one hunk extent, as described below.

### Matching

`matches(file)` decides whether the view appears in the View menu for that file. Keep it fast and side-effect free. Typical matchers use `file.path`, `file.changeType`, `file.isBinary`, or `file.isTooLarge`.

If `matches` throws, Hunk excludes the view for that file and keeps raw diff.

### Layout input

`layout(input)` receives one immutable snapshot:

| Field                | Meaning                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `file`               | The public file model, including path, change type, stats, patch text, and ordered hunk summaries. |
| `width`              | Available terminal columns. Return the same layout for the same input and width.                   |
| `signal`             | Aborts when a reload, resize, selection change, view change, or extension reload supersedes it.    |
| `changes`            | Typed added and removed source ranges with their hunk indexes.                                     |
| `readDocument(side)` | Lazily reads the exact `"old"` or `"new"` source document.                                         |

`readDocument` resolves to:

- a string for an available document;
- `""` for a valid empty document;
- `null` when the side does not exist, cannot be read, or exceeds host limits.

Cancellation aborts the pending request instead of producing a document value; use `input.signal` for any additional asynchronous work the layout starts. Patch text is available as `input.file.patch`, but a patch is not a complete source document. Use `readDocument` when parsing needs exact file contents. Reads are lazy and deduplicated within the request.

### Layout output

A layout contains `rows` and `hunkRows`.

Each row needs a stable `id` and a symbolic `spans` array. A span contains text plus an optional semantic tone and terminal attributes:

```ts
{
  id: "dependency:react",
  spans: [
    { text: "react", attributes: ["bold"] },
    { text: " 19.1.0 → 19.2.0", tone: "added" },
  ],
}
```

Tones are `muted`, `accent`, `accent-muted`, `syntax`, `added`, and `removed`. Attributes are `bold`, `italic`, `underline`, and `strikethrough`. Span text cannot contain newlines; create a separate row for each line. Hunk maps tones to the active theme while painting, so changing themes does not require a new layout.

`hunkRows` has one entry for every item in `input.file.hunks`, in the same order. Each entry is an inclusive, zero-based extent into `rows`. Hunk uses these extents for `[`/`]` navigation and selected-hunk highlighting even when several preview rows represent one source hunk.

## Ask Hunk to syntax-highlight code

API version 24 adds declarative, host-owned syntax paint. The extension supplies complete code and exact span references; Hunk owns language resolution, Shiki/Pierre tokenization, the active theme, worker scheduling, caches, terminal safety, and plain fallback. Extensions never supply colors, HAST, or tokens.

```ts
const oldText = await input.readDocument("old");
const newText = await input.readDocument("new");
if (oldText === null || newText === null) return null;
const firstLine = (text: string) => text.replace(/\r\n?|\n/g, "\n").split("\n")[0] ?? "";
const oldLine = firstLine(oldText);
const newLine = firstLine(newText);
const newPrefix = Math.min(newLine.length, /^\s*/.exec(newLine)?.[0].length ?? 0);

return {
  codeDocuments: [
    { id: "old", text: oldText }, // language defaults to host detection for input.file
    { id: "new", text: newText, language: "typescript" },
  ],
  rows: [
    {
      id: "split:1",
      spans: [
        { text: "OLD 1 │ ", tone: "muted" },
        { text: oldLine, syntax: { documentId: "old", line: 1 } },
        { text: "   NEW 1 │ ", tone: "muted" },
        { text: newLine.slice(0, newPrefix) },
        {
          text: newLine.slice(newPrefix),
          syntax: { documentId: "new", line: 1, range: [newPrefix, newLine.length] },
        },
      ],
    },
  ],
  hunkRows: [{ startRow: 0, endRow: 0 }],
};
```

Each `ExtensionFileViewCodeDocument` has a layout-local `id`, complete `text`, and optional `language`. Hunk tokenizes the whole document for correct multiline comments, strings, templates, embedded languages, and Markdown fences, but starts work only when a visible or nearby row references it. An explicit language is host-resolved; an unsupported language stays plain.

A span's `syntax` uses a `documentId`, one-based `line`, and optional zero-based, half-open UTF-16 `range`. Omit the range for a complete line. A split row can reference different old/new or generated/transformed documents. Keep gutters, blame columns, markers, separators, ellipses, and padding in ordinary spans.

Hunk normalizes CRLF and lone CR to LF, preserves final-newline semantics, and strips terminal controls line by line. The retained safe span text must exactly equal the referenced line or slice. Coordinates are UTF-16 before terminal-cell conversion: tabs count as one UTF-16 unit and OpenTUI paints each at its fixed two-cell width. A mismatch rejects the layout rather than guessing.

Syntax foregrounds override the span tone where tokens exist; gaps keep the tone, authored attributes survive, and selected/current-row backgrounds remain Hunk-owned. Highlight arrival is async and paint-only: it never changes text, wrapping, row height, geometry, notes, navigation, layout generation, or scrolling. Unsupported/oversized work, cancellation, queue pressure, stale replies, and highlighter failures retain symbolic FileView spans. Invalid layouts or unavailable native text measurement fall back to raw diff because exact geometry cannot be guaranteed.

Syntax references do not replace `sourceRanges`. `syntax` controls paint only and can appear outside hunks; `sourceRanges` alone bind note placement and navigation. Custom components do not receive tokens or syntax colors, though their symbolic fallback spans may request syntax paint.

Declare `"hunk": { "apiVersion": 26 }` in a folder extension that uses `codeDocuments` or `syntax`. See the checked-in [code-document file view](https://github.com/modem-dev/hunk/tree/main/examples/extensions/code-document-file-view) example for full old/new documents, gutters, and complete/partial references.

## Keep inline notes attached to source

A row may declare the exact old/new source lines it presents:

```ts
{
  id: "rendered-paragraph:4",
  spans: [{ text: "A rendered paragraph" }],
  sourceRanges: [{ side: "new", range: [12, 15] }],
}
```

Source ranges are inclusive and one-based. Hunk verifies that they exist in the exact source document, do not overlap ranges owned by other rows on the same side, and belong to one hunk extent.

When agent notes are visible, Hunk uses these bindings to insert its own note cards before the matching preview row. The extension never receives note contents and never measures note UI.

Note placement is all-or-raw for each file. If any visible note has no unique bound row, Hunk temporarily shows the complete raw diff rather than hiding the note or guessing where it belongs. The selected preview returns when notes are hidden or all bindings become resolvable. Draft note editing also remains on raw diff.

Omit `sourceRanges` if the preview does not support inline-note placement. The preview still works whenever no visible note requires a binding.

## Paint a fixed-height JSX row

A row can replace its symbolic paint with a constrained React/OpenTUI component:

```tsx
{
  id: "package-summary",
  spans: [{ text: "Package changes", attributes: ["bold"] }],
  component: {
    height: 2,
    render: ({ width, height, selected, rowIndex, theme }) => (
      <box
        style={{
          width,
          height,
          backgroundColor: selected ? theme.selectedHunk : theme.panel,
        }}
      >
        <text content={`Package changes · row ${rowIndex}`} style={{ fg: theme.text }} />
      </box>
    ),
  },
}
```

The declared height is final. Hunk measures and windows the review before mounting components, then clips each component to its assigned rectangle. A component cannot grow the row, replace the scrollbox, or perform post-mount measurement that changes review geometry.

Painter props contain only fixed geometry, selected-hunk state, row position, and a live semantic `theme`. Theme changes repaint the component without rerunning `layout`.

Always provide useful `spans`. If the component throws, Hunk paints those spans inside the same fixed height. Components are non-focusable paint surfaces; registered commands are the supported keyboard path. Mouse delivery is cooperative, while wheel scrolling, dragging, and unhandled input remain host-owned.

React hook state is temporary paint state. It is lost when windowing unmounts the row, a width change creates a new layout, the user switches presentations, or the extension/session reloads. Keep durable extension state outside the row component.

## Interactive previews

Add a `mode` when a preview needs keyboard input:

```ts
mode: {
  onKey: (key, ctx) => {
    if (key.name === "space") {
      ctx.fileViews.refresh("preview");
      return "handled";
    }
    return "pass";
  },
},
```

Start it from a command with `ctx.fileViews.enterMode("preview")`. Entering also selects the preview and returns whether the mode started. Only one interactive preview mode runs at a time; use `exitMode()` to stop it and `isModeActive("preview")` to check it. It may overlap a session keyboard mode, but receives keys first until it exits.

`onKey` returns `"handled"` to consume a key, `"pass"` to continue through any active session keyboard mode and then normal Hunk routing, or `"exit"` to consume the key and stop. It must return synchronously. When the file-view mode is the highest-priority input owner, Escape is reserved by Hunk and exits it.

Modes also exit when their file, presentation, extension, or review session changes. Optional `onEnter` and `onExit` callbacks track that lifecycle and must return synchronously; `onExit` runs exactly once per activation. A failing or asynchronous `onEnter` or `onKey` exits the mode, and any callback failure warns without breaking the review.

## Validation and fallback

Hunk validates every returned layout before using it. Current request limits are:

| Limit             |                Maximum |
| ----------------- | ---------------------: |
| Rows              |                 10,000 |
| Spans             |                 40,000 |
| Source bindings   |                 40,000 |
| Code documents    |                     64 |
| Code text         | 1,000,000 UTF-16 units |
| Code lines        |                 10,000 |
| Symbolic text     |   1,000,000 characters |
| One component row |      256 terminal rows |
| Complete layout   |  100,000 terminal rows |
| Layout request    |            1.5 seconds |

Layout work runs with bounded concurrency and cached results. Hunk discards layouts prepared for an old width, file snapshot, registration, or cancelled request.

A `null`, invalid, oversized, cancelled, timed-out, or throwing layout produces raw diff. A component failure affects only that row. Extensions are trusted code rather than a sandbox, but they should still treat fallback as a normal part of the contract.

## Examples

- [Rendered Markdown](https://github.com/modem-dev/hunk/tree/main/examples/extensions/rendered-markdown) is an installable symbolic-row preview with exact-source bindings and inline notes.
- [JSX file view](https://github.com/modem-dev/hunk/tree/main/examples/extensions/jsx-file-view) demonstrates fixed-height React/OpenTUI rows.
- [JSX file-view gallery](https://github.com/modem-dev/hunk/tree/main/examples/extensions/jsx-file-view-gallery) includes TypeScript, CSS color, package dependency, and mixed raw/custom review examples.
- [Code-document file view](https://github.com/modem-dev/hunk/tree/main/examples/extensions/code-document-file-view) demonstrates API-v26 host-owned syntax paint with complete old/new documents, semantic gutters, and full/partial references.

The examples are not bundled or loaded by default. Run one directly while developing:

```bash
bun run packages/hunk/src/main.tsx -- diff \
  --extension ./examples/extensions/rendered-markdown \
  ./examples/extensions/jsx-file-view-gallery/mixed-review/fixtures/before/README.md \
  ./examples/extensions/jsx-file-view-gallery/mixed-review/fixtures/after/README.md
```

For installation, discovery, folder extensions, and trust, start with [Extensions](/docs/extend/extensions/). For the rest of the API object, see [Extension API](/docs/extend/extension-api/).
