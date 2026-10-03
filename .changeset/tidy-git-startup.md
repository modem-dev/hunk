---
"hunkdiff": patch
---

Speed up Git diff startup by overlapping independent stats, moved-line configuration, source identity, and untracked-file queries while preserving oversized-file exclusions and waiting for pending reads on failure or cancellation.
