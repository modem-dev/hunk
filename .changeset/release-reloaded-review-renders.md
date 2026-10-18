---
"hunkdiff": patch
---

Fix a memory leak in `--watch` and other live reloads where every reload kept the previous review's files and render state alive, so long-running sessions grew without bound.
