---
"hunkdiff": patch
---

Optimize terminal cell width measurement so diffs with CJK, emoji, and chrome-glyph runs render faster: single-scalar clusters now measure through a fast zero-width check plus the East Asian Width table instead of string-width's expensive emoji regexes, while multi-scalar clusters still defer to string-width for identical results.
