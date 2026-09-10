---
"hunkdiff": patch
---

Resolve bundled skills from the nearest matching directory, preferring `hunkdiff/skills`, then `skills`, then `node_modules/hunkdiff/skills` within that directory to avoid unrelated ancestor and nested-package copies.
