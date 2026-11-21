---
"hunkdiff": minor
---

Add `Y` (`hunk.review.copySelectedHunk`, also under File → Copy selected hunk) to copy the selected hunk's raw diff text to the clipboard.

`Y` is now a built-in key, so an extension command that binds `Y` has that chord refused at load; its other chords and menu entry keep working. Rebind the extension command, or move `hunk.review.copySelectedHunk` off `Y` in your keybindings to free the key.
