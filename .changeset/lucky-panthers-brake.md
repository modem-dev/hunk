---
"hunkdiff": minor
---

Agent notes can now carry STML markup — a small HTML-like markup rendered as real terminal UI inside the inline note card (bordered boxes, rows of shapes, gauges, lists, badges, code blocks, styled text). Provide it via the `markup` field on agent-context sidecar annotations, `hunk session comment add --markup`, or a `markup` field on `comment apply` batch items; the plain `summary` stays as the fallback and list view text.

Two new commands make markup easy to author well: `hunk markup guide` prints a pattern-driven authoring guide (gauges, pipelines, scorecards, checklists), and `hunk markup render (<file> | -)` previews markup as terminal text at any width without launching the TUI, with render notes on stderr or in `--json` output. `comment add`/`apply` responses also return `markupNotes` when a comment's markup degraded, so agents get corrective feedback in the write path itself.
