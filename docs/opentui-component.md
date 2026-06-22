# OpenTUI component

`hunkdiff/opentui` exports reusable terminal diff components built from the same renderer as the Hunk CLI.

Use `HunkDiffView` when you want a batteries-included single-file diff, or compose the lower-level primitives when you want to build your own Hunk-like review UI without Hunk's sidebar, menus, global keyboard shortcuts, or session behavior.

## Install

```bash
npm i hunkdiff @opentui/core@^0.1.88 @opentui/react@^0.1.88 react
```

`hunkdiff` declares OpenTUI and React as peer dependencies, so install them in your app.

## Quick start

```tsx
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { HunkDiffView, createHunkDiffFile, parseDiffFromFile } from "hunkdiff/opentui";

const metadata = parseDiffFromFile(
  {
    cacheKey: "before",
    contents: "export const value = 1;\n",
    name: "example.ts",
  },
  {
    cacheKey: "after",
    contents: "export const value = 2;\nexport const added = true;\n",
    name: "example.ts",
  },
  { context: 3 },
  true,
);

const renderer = await createCliRenderer({
  useAlternateScreen: true,
  useMouse: true,
  exitOnCtrlC: true,
});
const root = createRoot(renderer);

root.render(
  <HunkDiffView
    diff={createHunkDiffFile({
      id: "example",
      metadata,
      language: "typescript",
      path: "example.ts",
    })}
    layout="split"
    width={88}
    theme="midnight"
  />,
);
```

In a real app, derive `width` from your layout or `useTerminalDimensions()`.

## Convenience vs primitives

### `HunkDiffView`

`HunkDiffView` renders one file and can own an OpenTUI `scrollbox`:

```tsx
<HunkDiffView diff={file} width={88} layout="split" scrollable />
```

Use it when you just want a drop-in diff viewer.

### `HunkDiffBody`

`HunkDiffBody` renders only the diff body for one file. It does not create a scrollbox, file nav, keyboard shortcuts, menus, or session bridge behavior:

```tsx
<scrollbox width="100%" height="100%" scrollY>
  <HunkDiffBody file={file} width={88} layout="stack" selectedHunkIndex={2} />
</scrollbox>
```

Use it when your app owns scrolling or surrounding layout.

### `HunkDiffFileHeader`

`HunkDiffFileHeader` renders Hunk's compact file label/stats header:

```tsx
<HunkDiffFileHeader file={file} width={88} onSelect={() => selectFile(file.id)} />
```

### `HunkReviewStream`

`HunkReviewStream` renders a top-to-bottom multi-file review stream without Hunk's app shell, chrome, keybindings, or scroll owner:

```tsx
<scrollbox width="100%" height="100%" scrollY>
  <HunkReviewStream
    files={files}
    width={terminal.width}
    layout="split"
    selection={{ fileId, hunkIndex }}
    onSelectionChange={({ fileId, hunkIndex }) => {
      setFileId(fileId);
      setHunkIndex(hunkIndex);
    }}
  />
</scrollbox>
```

Use it when you want Hunk's main review stream but your own navigation, chrome, scrolling, and keybindings.

### `HunkFileNav`

`HunkFileNav` renders Hunk's file navigation list as an optional primitive. It does not render borders, outer padding, or a scrollbox; host apps own surrounding chrome and scrolling.

```tsx
<scrollbox width={32} height="100%" scrollY>
  <HunkFileNav
    files={files}
    selectedFileId={fileId}
    width={32}
    onSelectFile={(nextFileId) => setFileId(nextFileId)}
  />
</scrollbox>
```

## Building file inputs

The public file model is intentionally higher-level than Hunk's internal renderer rows. Row models are not exported.

```ts
type HunkDiffFileInput = {
  id: string;
  metadata: FileDiffMetadata;
  language?: string;
  path?: string;
  previousPath?: string;
  patch?: string;
  stats?: { additions: number; deletions: number };
  isBinary?: boolean;
  isTooLarge?: boolean;
  isUntracked?: boolean;
  statsTruncated?: boolean;
};

type HunkDiffFile = Omit<HunkDiffFileInput, "stats"> & {
  stats: { additions: number; deletions: number };
};
```

Components accept `HunkDiffFileInput` directly. Use `createHunkDiffFile(...)` when you want a normalized `HunkDiffFile` with paths and stats filled in once:

```tsx
import { createHunkDiffFile, parseDiffFromFile } from "hunkdiff/opentui";

const file = createHunkDiffFile({
  id: "example",
  metadata: parseDiffFromFile(beforeFile, afterFile, { context: 3 }, true),
  path: "example.ts",
  language: "typescript",
});
```

### From before/after contents

Use `parseDiffFromFile(...)` when you already have the old and new file contents.

```tsx
import { createHunkDiffFile, parseDiffFromFile } from "hunkdiff/opentui";

const file = createHunkDiffFile({
  id: "example",
  metadata: parseDiffFromFile(beforeFile, afterFile, { context: 3 }, true),
});
```

### From unified diff text

Use `createHunkDiffFilesFromPatch(...)` for a quick multi-file patch path:

```tsx
import { createHunkDiffFilesFromPatch } from "hunkdiff/opentui";

const files = createHunkDiffFilesFromPatch(patchText, "example:patch");
```

If you need direct access to Pierre's parser, `parsePatchFiles(...)` is still re-exported.

## Common props

| Prop                 | Type                                                                                                                                                       | Default      | Notes                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------- |
| `layout`             | `"split" \| "stack"`                                                                                                                                       | `"split"`    | Chooses side-by-side or stacked rendering.                                          |
| `width`              | `number`                                                                                                                                                   | —            | Required content width in terminal columns.                                         |
| `theme`              | `"graphite" \| "midnight" \| "paper" \| "ember" \| "catppuccin-latte" \| "catppuccin-frappe" \| "catppuccin-macchiato" \| "catppuccin-mocha" \| "zenburn"` | `"graphite"` | Matches Hunk's built-in themes.                                                     |
| `showLineNumbers`    | `boolean`                                                                                                                                                  | `true`       | Toggles line-number columns.                                                        |
| `showHunkHeaders`    | `boolean`                                                                                                                                                  | `true`       | Toggles `@@ ... @@` hunk header rows.                                               |
| `showFileSeparators` | `boolean`                                                                                                                                                  | `true`       | Toggles separator rows between files in `HunkReviewStream`.                         |
| `wrapLines`          | `boolean`                                                                                                                                                  | `false`      | Wraps long lines instead of clipping horizontally.                                  |
| `horizontalOffset`   | `number`                                                                                                                                                   | `0`          | Scroll offset for non-wrapped code rows.                                            |
| `highlight`          | `boolean`                                                                                                                                                  | `true`       | Enables syntax highlighting.                                                        |
| `selectedHunkIndex`  | `number`                                                                                                                                                   | `0`          | Highlights one hunk as the active target for single-file components.                |
| `scrollable`         | `boolean`                                                                                                                                                  | `true`       | `HunkDiffView` only; primitives should be wrapped in OpenTUI scrollbox when needed. |

## Other exports

- `parseDiffFromFile`
- `parsePatchFiles`
- `FileDiffMetadata`
- `createHunkDiffFile`
- `createHunkDiffFilesFromPatch`
- `countHunkDiffStats`
- `HUNK_DIFF_THEME_NAMES`
- `HunkDiffThemeName`
- `HunkDiffLayout`
- `HunkDiffFile`
- `HunkDiffFileInput`
- `HunkDiffStats`
- `HunkDiffSelection`
- component prop types

`parseDiffFromFile`, `parsePatchFiles`, and `FileDiffMetadata` are re-exported from `@pierre/diffs` so you can build metadata without adding a second diff dependency.

## Examples

- Runnable demo overview: [`examples/README.md`](../examples/README.md)
- Component demos: [`examples/7-opentui-component/README.md`](../examples/7-opentui-component/README.md)

The in-repo demos import from `../../src/opentui` so they run from source. Published consumers should import from `hunkdiff/opentui`.
