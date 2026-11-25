---
"hunkdiff": patch
---

Upgrade `@pierre/diffs` to 1.7.1. The optional `@pierre/diffs` peer dependency of `hunkdiff/opentui` now expects 1.7.1, whose `parsePatchFiles` takes an options object (`{ cacheKeyPrefix, throwOnError }`).
