---
"hunkdiff": minor
---

Hunk now runs on OpenTUI 0.5, picking up its faster FFI layout reads and a fix for duplicate live frame timers. Embedders of `hunkdiff/opentui` need to move their `@opentui/core` and `@opentui/react` peer installs to `^0.5.1`.
