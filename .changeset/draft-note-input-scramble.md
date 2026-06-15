---
"hunkdiff": patch
---

Fix scrambled text when typing into a draft review note under Solid. The review row plan is rebuilt on every keystroke, which recreated the note's text editor and reset its cursor to the start, so fast input landed out of order. The draft row now keeps a stable identity while its contents update reactively, so the editor stays mounted and characters land in order.
