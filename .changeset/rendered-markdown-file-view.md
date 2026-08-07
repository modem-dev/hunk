---
"hunkdiff": minor
---

Add a streamlined experimental extension file-view contract plus an optional, user-installable Markdown preview example. File views read exact source lazily, return generic host-rendered rows, and may bind rows to exact source ranges so Hunk can place inline notes. Raw diff remains the default and the all-or-raw fallback for unresolved note bindings. The View menu can apply the active presentation to every matching file in the changeset without widening extension command controls.
