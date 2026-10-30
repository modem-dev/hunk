# Review note navigator extension

Lists every note currently saved in Hunk's shared ReviewStore, then navigates to a selected visible note's authoritative source anchor. The example shows how `ctx.review.snapshot()` complements dialogs and live navigation: selection and note events alone cannot recover notes that already existed before the extension began listening.

Run it directly from this checkout:

```bash
bun run packages/hunk/src/main.tsx -- diff --extension ./examples/extensions/review-note-navigator
```

Save one or more review notes, then run **Extensions → Navigate saved review note…** (`F8`). Each choice includes its reconciliation status, file, preferred line, side, and summary.

- Active notes reveal their current source line.
- Stale notes reveal the last authoritative anchor Hunk retained.
- Orphaned notes remain visible in the inventory but produce a warning because they have no current review location.
- A note whose file is hidden by Hunk's current file filter remains in the inventory, but guarded navigation refuses the hidden target with a warning; clear the filter and retry.
- Drafts and static sidecar annotations that never entered ReviewStore are intentionally absent.

The command captures the complete note inventory before opening its selector. After the user chooses, it reads the authoritative snapshot again and resolves the selected note by stable note id, so an edit made by another review surface cannot make it navigate using an obsolete anchor. A reload cancels the dialog and retires the command's review controls.
