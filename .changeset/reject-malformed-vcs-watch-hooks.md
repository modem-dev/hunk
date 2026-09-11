---
"hunkdiff": patch
---

Extension VCS operation registration now requires `watchSignature` and `watchPlan` to be absent or callable. A non-callable hook is dropped along with its operation at registration instead of throwing a `TypeError` the first time watch planning invokes it.
