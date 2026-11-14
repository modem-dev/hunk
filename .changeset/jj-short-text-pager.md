---
"hunkdiff": patch
---

Short non-diff output such as `jj status` now prints and exits when Hunk is jj's pager, instead of holding the screen in `less`. When Hunk falls back to `less` for plain text and `LESS` is unset, it now sets `LESS=FRX`, the same default Git uses.
