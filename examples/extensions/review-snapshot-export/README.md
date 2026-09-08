# Review snapshot export extension

Exports Hunk's authoritative saved review state as JSON. The example shows why `ctx.review.snapshot()` is more useful than accumulating `note_created` events: one command receives every note currently retained by the shared ReviewStore, including stale and orphaned notes an exporter must handle explicitly.

Run it directly from this checkout:

```bash
bun run packages/hunk/src/main.tsx -- diff --extension ./examples/extensions/review-snapshot-export
```

Add one or more review notes, then run **Extensions → Export review snapshot…** (`F9`) and choose a new output path. Relative paths resolve from the review's working directory; the example refuses to overwrite an existing file.

The JSON includes:

- the opaque producer generation and ReviewStore revision
- every reviewed file's stable `fileKey`, runtime navigation id, content identity, status, and path
- all saved live and reviewer notes with their resolved old/new anchors and reconciliation status

Draft notes and static sidecar annotations that never entered ReviewStore are intentionally absent. Saved notes appear in live-arrival order followed by reviewer-creation order.

The command captures a snapshot before opening its path dialog, then reads the controls again before writing. If either the generation or revision changed, it refuses the stale export and asks the user to rerun the command. Publishers can use the same check before an irreversible network request.

## Trust

This example uses `node:fs` directly to write the user-selected export path. Hunk extensions run with the user's full permissions; this is distinct from `ctx.workspace`, which mediates writes to reviewed files and asks for consent. Install and run only extensions you trust.
