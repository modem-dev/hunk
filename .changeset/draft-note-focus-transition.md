---
"hunkdiff": patch
---

Hold printable input typed while a note draft is still mounting instead of dispatching it as global
commands.

The inline note editor takes keyboard ownership in a later render than the key or click that opens
it, and OpenTUI routes one input chunk's keys synchronously. Characters typed immediately after
opening a draft — a fast `c`, or a click on the add-note badge followed by typing — were therefore
dispatched as global shortcuts: the note stayed empty while an unrelated command ran. Those
characters are now held for the draft and delivered to the editor the moment it takes focus, while
Escape and Ctrl-S in the same window still cancel and save the draft.
