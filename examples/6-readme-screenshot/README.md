# 6-readme-screenshot

A screenshot-optimized demo for the main README: a multi-file UI refactor with inline agent rationale.

## Run

```bash
hunk patch examples/6-readme-screenshot/change.patch \
  --agent-context examples/6-readme-screenshot/agent-context.json \
  --mode split \
  --theme github-dark-default
```

## Screenshot setup

- use a wide terminal so the sidebar and split diff are both visible
- keep the first file selected: `src/components/ReviewSummaryCard.tsx`
- make sure agent notes are visible
- capture the first annotated hunk with the note popover open

## What it shows well

- inline agent rationale beside the changed code
- a clear mix of removed and added lines in one hunk
- a visible multi-file sidebar
- TSX prop renames, copy edits, and helper extraction with strong syntax color
