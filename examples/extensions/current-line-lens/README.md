# Current-line lens extension

Pins the selected split-diff row at the bottom of the review, old version above new.

Run it from this checkout:

```bash
bun run src/main.tsx -- diff --mode split --extension ./examples/extensions/current-line-lens
```

The pane opens on load. Toggle it from the **Extensions** menu. It uses the public `currentLine` pane API and hides itself when that paint is unavailable.

Copy this directory to your Hunk extensions directory to install it.
