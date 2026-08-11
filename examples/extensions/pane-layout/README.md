# Pane layout extension

A minimal installable example of Hunk's four-edge pane API. It registers a resizable right pane and fixed two-row top and bottom panes, all controlled through the same `ctx.panes` state.

Run it from this checkout:

```bash
bun run src/main.tsx -- diff --extension ./examples/extensions/pane-layout
```

Press `ctrl+p` or choose **Extensions → Toggle pane layout example**. The top and bottom panes span the central review column; the side pane remains outside it. Resize the right pane by dragging its divider.

Copy the directory to your Hunk extensions directory to install it. Its `package.json` manifest keeps the folder together as one extension.
