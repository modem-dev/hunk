# JSX file-view gallery

Three opt-in presentations exercise the constrained React/OpenTUI row contract against checked-in, realistic file pairs. Run one command from the repository root, then press **F8** or choose **Extensions → Toggle JSX demo for current file**. Press F8 again to restore Pierre's raw diff.

## 1. Change atlas

Nested boxes, responsive meters, semantic color, and selected-hunk styling summarize a multi-hunk TypeScript refactor. It uses no source parser and works from public hunk/change metadata alone.

```bash
bun run packages/hunk/src/main.tsx -- diff \
  --extension ./examples/extensions/jsx-file-view-gallery \
  --mode stack \
  examples/extensions/jsx-file-view-gallery/fixtures/change-atlas/before.ts \
  examples/extensions/jsx-file-view-gallery/fixtures/change-atlas/after.ts
```

## 2. CSS palette delta

The extension lazily reads both exact documents, associates changed opaque three- or six-digit hexadecimal custom properties with each real diff hunk, and paints old/new terminal color swatches inside deterministic two-row rectangles.

```bash
bun run packages/hunk/src/main.tsx -- diff \
  --extension ./examples/extensions/jsx-file-view-gallery \
  --mode stack \
  examples/extensions/jsx-file-view-gallery/fixtures/css-palette/before.css \
  examples/extensions/jsx-file-view-gallery/fixtures/css-palette/after.css
```

## 3. Dependency delta

A conservative package-file parser highlights only the changed semantic-version segment: patch-only changes emphasize the patch number, minor upgrades emphasize the minor number, and major upgrades emphasize the full old/new strings. It retains positional bounds for every parsed hunk; invalid JSON or unavailable source falls back to raw diff.

```bash
bun run packages/hunk/src/main.tsx -- diff \
  --extension ./examples/extensions/jsx-file-view-gallery \
  --mode stack \
  examples/extensions/jsx-file-view-gallery/fixtures/package-dependencies/before/package.json \
  examples/extensions/jsx-file-view-gallery/fixtures/package-dependencies/after/package.json
```

## Mixed five-file review

To see all three preview types retained together between ordinary raw diffs—and enough content to exercise stream scrolling—run:

```bash
bun run ./examples/extensions/jsx-file-view-gallery/mixed-review/run.ts
```

Follow the short activation sequence in [`mixed-review/README.md`](./mixed-review/README.md).

## Contract illustrated

- Every painter stays inside a declared fixed-height row; geometry, scrolling, windowing, and hunk navigation remain host-owned.
- Every row keeps useful symbolic spans for row-local error fallback, clipped to the same fixed rectangle.
- Semantic data is captured in closures during `layout`; painters receive only bounded paint props and use Hunk's live paint-only semantic theme palette.
- The demos intentionally have no pointer handlers. Registered commands are the supported interaction path.
- Layouts return `null` when exact source is unavailable or no supported semantic row can be attributed. Mixed diffs may retain neutral summary rows for non-semantic hunks so navigation stays positional.
- Rows bind conservatively attributed exact-source ranges. Hunk renders a note inside the alternate view only when its preferred-side anchor resolves uniquely; otherwise the complete file falls back to raw diff.

This gallery is experimental and is not loaded unless you explicitly pass or install its folder. See [`docs/file-view-jsx-poc.md`](../../../docs/file-view-jsx-poc.md) for the full contract.
