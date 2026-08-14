---
"hunkdiff": patch
---

Fix `hunk diff` taking tens of seconds in repos with many untracked files by synthesizing untracked diffs in-process instead of spawning one `git diff --no-index` subprocess per file.
