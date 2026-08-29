---
"hunkdiff": patch
---

Refuse to start watch mode under Bun versions older than 1.3.14, which can deadlock filesystem watcher cleanup and leave Hunk unresponsive.
