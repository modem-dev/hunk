# JSX file-view POC extension

An opt-in proof of concept for fixed-height React/OpenTUI rows in alternate file presentations. It appears only for files with at least two parsed hunks and creates two custom rows per hunk, with stable row IDs and explicit hunk bounds.

Run it from this checkout against a multi-hunk working-tree change:

```bash
bun run packages/hunk/src/main.tsx -- diff --extension ./examples/extensions/jsx-file-view
```

Choose **Extensions → Toggle JSX hunk cards (POC)**. The row component uses a React state hook and OpenTUI `box`/`text` elements. Its registered F8 command/menu item is the supported keyboard path. A cooperatively delivered, un-dragged left-button mouse-up toggles local detail and stops propagation; wheel, drag, and unhandled input remain host-owned. The row is a non-focusable paint surface, with no portal, renderer, focus, or input-delivery guarantee. Each component is a closure over the hunk summary; Hunk passes it only bounded paint props, including a live semantic theme palette that does not participate in layout. The `spans` on every row are the host-rendered fallback, clipped to the same declared fixed height if the component fails. Hook state survives selected-hunk updates while mounted, but is intentionally lost when windowing unmounts the row or a new layout generation replaces it.

This example is deliberately opt-in and experimental. See [`docs/file-view-jsx-poc.md`](../../../docs/file-view-jsx-poc.md) for constraints.
