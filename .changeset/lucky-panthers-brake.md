---
"hunkdiff": minor
---

Agent notes can now carry STML markup — a small HTML-like markup rendered as real terminal UI inside the inline note card (bordered boxes, rows of shapes, lists, badges, code blocks, styled text). Provide it via the `markup` field on agent-context sidecar annotations, `hunk session comment add --markup`, or a `markup` field on `comment apply` batch items; the plain `summary` stays as the fallback and list view text.
