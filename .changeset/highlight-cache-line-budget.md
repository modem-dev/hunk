---
"hunkdiff": patch
---

Budget the syntax highlighting cache by lines instead of file count, so reviews of many small files stop re-highlighting as you scroll and reviews of very large files stay within a bounded memory footprint.
