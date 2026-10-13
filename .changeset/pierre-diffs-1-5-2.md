---
"hunkdiff": patch
---

Faster, more forgiving patch parsing. Quoted `diff --git` filenames with escaped characters (spaces, non-ASCII) now decode to the real file name, and hunks whose declared line counts disagree with their body are repaired instead of dropped. Syntax highlighting is unchanged.
