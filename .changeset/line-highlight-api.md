---
"hunkdiff": minor
---

Extensions can mark character ranges inside diff lines with `hunk.registerLineHighlighter` (API v5): source-addressed, tone-based marks painted inside Hunk's own rendering with guaranteed contrast on every line kind, invalidated through `ctx.highlights.refresh`.
