---
"hunkdiff": patch
---

Fix `hunk pager` pegging a CPU core and growing to gigabytes of memory on large color-heavy
input. Restoring preserved ANSI styling rescanned and reallocated the whole document once per
sequence, so a `git log --graph --color=always` stream from a host like LazyGit took minutes of
solid CPU per process and never produced output. Styling is now restored in a single pass: a 3 MB
branch log pages through in well under a second.
