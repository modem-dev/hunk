# Current-line lens extension

An installable example of an extension pane using Hunk's opaque current-line paint. In split layout it pins the selected row at the bottom of the review, with the old version above the new version.

Run it from this checkout:

```bash
bun run src/main.tsx -- diff --mode split --extension ./examples/extensions/current-line-lens
```

The pane opens when the extension loads. Choose **Extensions → Toggle current-line lens example** to hide or restore it. It stays out of the layout when current-line paint is unavailable, including stacked layout and sessions with the current-line marker disabled.

The example uses only `hunkdiff/extension`: `currentLine: true` opts into updates, `available()` keeps the fixed pane out of unsuitable frames, and `props.currentLine.render("old" | "new", width)` delegates row painting back to Hunk without exposing renderer internals.

Copy the directory to your Hunk extensions directory to install it. Its `package.json` manifest keeps the folder together as one extension.
