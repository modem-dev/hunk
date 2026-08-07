# Mixed preview review

This launches one real five-file Git working-tree review that is intentionally taller than a terminal viewport:

- `README.md` — raw Markdown diff;
- `package.json` — dependency version-segment highlights;
- `scripts/deploy.py` — raw Python diff;
- `src/invoice.ts` — responsive change-atlas cards;
- `styles/theme.css` — exact-source color swatches.

The launcher creates a temporary repository, commits the checked-in `before` fixtures, copies the `after` fixtures into its working tree, and starts Hunk from this checkout. The repository is removed when Hunk exits.

From the Hunk repository root:

```bash
bun run ./examples/extensions/jsx-file-view-gallery/mixed-review/run.ts
```

Raw diff is deliberately the default. To build the mixed stream:

1. Click `package.json` in the sidebar and press **F8**.
2. Click `src/invoice.ts` and press **F8**.
3. Click `styles/theme.css` and press **F8**.
4. Click `README.md` to return to the top, then scroll through the main pane.

Selecting files only jumps the main review stream; it does not collapse other files. The three preview selections therefore remain active together, interleaved with the two raw Pierre diffs. Use `[` and `]` while scrolling to verify that hunk navigation crosses raw and custom sections using the same host-owned geometry.
