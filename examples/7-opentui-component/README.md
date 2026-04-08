# 7-opentui-component

Two minimal OpenTUI apps that embed `HunkDiffView` directly.

## Run

```bash
bun run examples/7-opentui-component/from-files.tsx
bun run examples/7-opentui-component/from-patch.tsx
```

## What it shows

- embedding `HunkDiffView` inside a normal OpenTUI app shell
- building `diff.metadata` with `parseDiffFromFile`
- parsing raw unified diff text with `parsePatchFiles`
- switching between split and stacked layouts with example shell controls
- a scrollable terminal diff component that other OpenTUI apps can reuse

The in-repo demos import from `../../src/opentui` so they run from source. Published consumers should import from `hunkdiff/opentui` instead.
