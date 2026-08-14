---
"hunkdiff": minor
---

Extensions can jump the review to one exact source line with `ctx.navigation.revealLine(fileId, side, line)` (API v5), so a target deep inside a tall hunk lands near the top of the viewport instead of pages below its anchor.
