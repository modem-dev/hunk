---
"hunkdiff": patch
---

`hunk session` commands that select a window with `--repo` or `--session-path` now say which path matched no live session, instead of failing with `protocol-validation-failed` (for example, when run from a different git worktree than the Hunk window).
