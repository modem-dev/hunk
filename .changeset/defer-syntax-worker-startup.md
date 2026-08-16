---
"hunkdiff": patch
---

Keep `hunk --version`, `--help`, `daemon serve`, and `hunk session *` off the diff-engine startup
path again, and release the syntax worker when the review app exits instead of at startup.
