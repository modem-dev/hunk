---
"hunkdiff": patch
---

Wrap plain-text agent notes by terminal cells instead of UTF-16 code
units, so CJK and emoji text wraps correctly instead of being truncated
with silent content loss. Long unbroken words split on grapheme
boundaries, so wide characters and surrogate pairs are never cut apart.
