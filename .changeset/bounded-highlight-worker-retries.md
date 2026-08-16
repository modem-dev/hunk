---
"hunkdiff": patch
---

Stop re-running a failed large-diff highlight on every scroll, pick up a later successful retry
without remounting the file, and charge worker highlight results to the cache budget by the payload
they actually retain.
