---
title: Comments and annotations
description: Attach human or agent review notes to the code and navigate them in context.
---

Notes are hunk-specific and render beside the rows they explain. Hunk intentionally keeps them in the review flow rather than in a separate comments screen.

## Add one agent comment

```bash
hunk session comment add \
  --repo . \
  --file README.md \
  --new-line 103 \
  --summary "Tighten this wording"
```

Choose exactly one `--old-line` or `--new-line` target. Add `--focus` only when the new note should move the user's viewport.

## Apply a batch

```bash
printf '%s\n' '{"comments":[{"filePath":"README.md","newLine":103,"summary":"Tighten this wording"}]}' \
  | hunk session comment apply --repo . --stdin
```

Every item needs `filePath`, `summary`, and exactly one target: `hunk`, `hunkNumber`, `oldLine`, or `newLine`. Hunk validates the complete batch before changing the live session.

## Inspect and clean up

```bash
hunk session comment list --repo .
hunk session comment list --repo . --type all
hunk session comment rm --repo . <comment-id>
hunk session comment clear --repo . --file README.md --yes
```

Use `--all --yes` to clear both live agent comments and human notes. Destructive clears require confirmation.

## Add a human note

In the TUI, move to the line you mean with `k` / `j` and press `c`, or click an add-note affordance. Human and agent notes are labeled by source. Use `{` and `}` to move through annotated hunks across the review stream.
