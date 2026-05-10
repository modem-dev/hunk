# 8-opentui-primitives

A small custom OpenTUI app assembled from Hunk's lower-level primitives instead of the full Hunk CLI app shell.

For package install and API details, see [OpenTUI component docs](../../docs/opentui-component.md).

## Run

```bash
bun run examples/8-opentui-primitives/primitives-demo.tsx
```

## What it shows

- `createHunkDiffFilesFromPatch` for turning unified diff text into public Hunk file models
- `HunkFileNav` for a standalone file list
- `HunkReviewStream` for a multi-file review stream without Hunk's menu bar or global shortcuts
- `HunkDiffFileHeader` and `HunkDiffBody` for a single-file view assembled by the host app
- Host-owned window borders/chrome around each primitive so you can inspect component boundaries
- Host-owned state for selected file and split/stack layout

The in-repo demo imports from `../../src/opentui` so it runs from source. Published consumers should import from `hunkdiff/opentui` instead.
