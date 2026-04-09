# OpenTUI component

`hunkdiff/opentui` exports `HunkDiffView`, a reusable terminal diff component built from the same renderer as the Hunk CLI.

Use it when you want Hunk's split or stack diff view inside your own OpenTUI app.

## Install

```bash
npm i hunkdiff @opentui/core @opentui/react react
```

`hunkdiff` declares OpenTUI and React as peer dependencies, so install them in your app.

## Quick start

```tsx
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { HunkDiffView, parseDiffFromFile } from "hunkdiff/opentui";

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
    diff={{
      id: "example",
      metadata,
      language: "typescript",
      path: "example.ts",
    }}
    layout="split"
    width={88}
    theme="midnight"
  />,
);
```

In a real app, derive `width` from your layout or `useTerminalDimensions()`.

## Building the `diff` input

`HunkDiffView` renders one file at a time. Pass a `diff` object shaped like this:

```ts
type HunkDiffFile = {
  id: string;
  metadata: FileDiffMetadata;
  language?: string;
  path?: string;
  patch?: string;
};
```

### From before/after contents

Use `parseDiffFromFile(...)` when you already have the old and new file contents.

```tsx
import { parseDiffFromFile } from "hunkdiff/opentui";

const metadata = parseDiffFromFile(beforeFile, afterFile, { context: 3 }, true);
```

### From unified diff text

Use `parsePatchFiles(...)` when you already have a patch string.

```tsx
import { parsePatchFiles } from "hunkdiff/opentui";

const parsed = parsePatchFiles(patchText, "example:patch", true);
const metadata = parsed.flatMap((entry) => entry.files)[0];

if (!metadata) {
  throw new Error("Expected at least one diff file.");
}
```

## Props

| Prop                | Type                                             | Default      | Notes                                                                     |
| ------------------- | ------------------------------------------------ | ------------ | ------------------------------------------------------------------------- |
| `diff`              | `HunkDiffFile`                                   | `undefined`  | File to render. When omitted, the component shows an empty-state message. |
| `layout`            | `"split" \| "stack"`                             | `"split"`    | Chooses side-by-side or stacked rendering.                                |
| `width`             | `number`                                         | —            | Required content width in terminal columns.                               |
| `theme`             | `"graphite" \| "midnight" \| "paper" \| "ember"` | `"graphite"` | Matches Hunk's built-in themes.                                           |
| `showLineNumbers`   | `boolean`                                        | `true`       | Toggles line-number columns.                                              |
| `showHunkHeaders`   | `boolean`                                        | `true`       | Toggles `@@ ... @@` hunk header rows.                                     |
| `wrapLines`         | `boolean`                                        | `false`      | Wraps long lines instead of clipping horizontally.                        |
| `horizontalOffset`  | `number`                                         | `0`          | Scroll offset for non-wrapped code rows.                                  |
| `highlight`         | `boolean`                                        | `true`       | Enables syntax highlighting.                                              |
| `scrollable`        | `boolean`                                        | `true`       | Set to `false` if your parent view owns scrolling.                        |
| `selectedHunkIndex` | `number`                                         | `0`          | Highlights one hunk as the active target.                                 |

## Other exports

- `parseDiffFromFile`
- `parsePatchFiles`
- `FileDiffMetadata`
- `HUNK_DIFF_THEME_NAMES`
- `HunkDiffThemeName`
- `HunkDiffLayout`
- `HunkDiffFile`
- `HunkDiffViewProps`

`parseDiffFromFile`, `parsePatchFiles`, and `FileDiffMetadata` are re-exported from `@pierre/diffs` so you can build `metadata` without adding a second diff dependency.

## Examples

- Runnable demo overview: [`examples/README.md`](../examples/README.md)
- Component demos: [`examples/7-opentui-component/README.md`](../examples/7-opentui-component/README.md)

The in-repo demos import from `../../src/opentui` so they run from source. Published consumers should import from `hunkdiff/opentui`.
