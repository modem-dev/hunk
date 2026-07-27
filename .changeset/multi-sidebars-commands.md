---
"hunkdiff": minor
---

Extensions can now register keyboard commands and any number of sidebar views. `hunk.registerCommand({ id, title, key }, handler)` joins the same dispatch table Hunk's own shortcuts run on — built-ins win key conflicts, and every app-level shortcut is now a named command in that one table. Command handlers receive `ctx.sidebars` controls, so a registered key can open, close, or toggle sidebar views. `hunk.registerSidebarView` is additive: views declare a `title`, `placement` (`"left"` or `"right"` of the review stream), `defaultOpen`, or `replacesDefault` to stand in for the built-in file navigation, and multiple panes can be open at once with per-pane resize. A view that fails rendering closes with a warning and the built-in file navigation reopens if nothing else is showing.
