---
"hunkdiff": patch
---

Fix mouse-selection copy misalignment on lines with wide (CJK, emoji) characters: drag, double-click, and triple-click selections now convert terminal cell columns into string indices before slicing, so the copied text matches the selected cells exactly. File-header rows with wide-character filenames now copy with the same cell alignment, and invisible zero-width characters at a selection boundary round-trip through the clipboard.
