---
title: OpenTUI components
description: Embed Hunk's Pierre-backed diff renderer in an OpenTUI React application.
---

The `hunkdiff/opentui` export exposes Hunk's renderer without the CLI shell, global keybindings, session broker, or menus.

## Install peers

```bash
npm install hunkdiff @pierre/diffs@1.3.5 @opentui/core@^0.5.6 @opentui/react@^0.5.6 react
```

Pierre diffs is optional for CLI-only installs but required when importing `hunkdiff/opentui`.

## Render one file

```tsx
import { HunkDiffView, createHunkDiffFile, parseDiffFromFile } from "hunkdiff/opentui";

const metadata = parseDiffFromFile(
  { cacheKey: "before", contents: "export const n = 1;\n", name: "value.ts" },
  { cacheKey: "after", contents: "export const n = 2;\n", name: "value.ts" },
  { context: 3 },
  true,
);

const file = createHunkDiffFile({ id: "value", metadata, path: "value.ts" });

<HunkDiffView diff={file} layout="split" width={88} scrollable />;
```

Derive `width` from your host layout. `HunkDiffView` can own its scrollbox; lower-level primitives do not.

## Choose the right primitive

- `HunkDiffView`: batteries-included single-file diff.
- `HunkDiffBody`: one file's body for a host-owned scrollbox.
- `HunkDiffFileHeader`: compact file label and stats.
- `HunkReviewStream`: top-to-bottom multi-file stream.
- `HunkFileNav`: file navigation without outer chrome or scrolling.

Use `createHunkDiffFilesFromPatch` for unified diff text or `parseDiffFromFile` for before/after contents. Row internals are deliberately not public; build on the normalized file model so rendering behavior remains shared with Hunk.

For complete prop tables and runnable examples, see `docs/opentui-component.md` and `examples/7-opentui-component/` in the repository.
