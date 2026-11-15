---
"hunkdiff": patch
---

Fix review reloads and hunk navigation: a watched review with `--agent-context` outside the repository keeps updating, a review keeps following file edits after `hunk session reload`, and next/previous hunk from a file with no hunks moves to the nearest hunk instead of jumping to the edge of the review.
