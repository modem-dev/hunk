---
"hunkdiff": patch
---

Measure text containing U+113D1 (and other grapheme Prepend characters) with the correct terminal width instead of counting the prepend as its own cell, so slicing and wrapping agree with `string-width`.
