---
"hunkdiff": minor
---

Agent notes can now carry STML markup — a small HTML-like markup rendered as real terminal UI inside the inline note card (bordered boxes, rows of shapes, gauges, lists, badges, code blocks, styled text). Provide it via the `markup` field on agent-context sidecar annotations, `hunk session comment add --markup`, or a `markup` field on `comment apply` batch items; the plain `summary` stays as the fallback and list view text.

Two new commands make markup easy to author well: `hunk markup guide` prints a pattern-driven authoring guide (gauges, pipelines, scorecards, checklists), and `hunk markup render (<file> | -)` previews markup as terminal text at any width without launching the TUI, with render notes on stderr or in `--json` output. Markup feedback follows the live session geometry: `hunk session context` reports `noteMarkupWidth` (the width notes render at in the current layout and terminal size), and `comment add`/`apply` responses echo the `markupWidth` they validated at plus `markupNotes` when the markup degraded — so agents design for the width the user is actually looking at, whether that is a narrow split dock or a full-width unified pane on a large screen.
