---
"hunkdiff": minor
---

`/` now searches diff content from a `less`-style prompt on the status row and `n` / `N` step through matches with in-diff marks; the file filter stays on Tab and in the menu (`"hunk.review.focusFilter" = "/"` restores it), note stepping ships unbound, and extension API 27 adds `ctx.selection.files`.
