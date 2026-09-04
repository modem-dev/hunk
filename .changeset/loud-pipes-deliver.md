---
"hunkdiff": patch
---

Fix `hunk pager` truncating its output at 64 KB when a host reads it through a pipe, which cut off
large documents for Git's pager contract, LazyGit, and `| less`. Headless commands now hand the
whole document to the stdout descriptor before exiting, so a piped consumer receives every byte.
