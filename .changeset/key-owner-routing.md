---
"hunkdiff": patch
---

One keypress no longer triggers two actions when a modal surface and the focused widget both want it. In pager mode, opening a menu or the theme selector and pressing an arrow no longer scrolls the diff behind the dialog. Escape closing the Controls help or Agent skill overlay no longer wipes typed filter text, Enter on a menu item no longer also submits the focused filter, and F10 no longer pops the menu bar over an in-progress note draft. Global key handlers now answer one three-state ownership question (`notMine` / `mine` / `focused`) and consumption is enforced centrally, so a handler can no longer act on a key while leaving it live for the focused widget.
