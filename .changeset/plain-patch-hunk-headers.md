---
"hunkdiff": patch
---

Keep each file's patch text intact in plain unified diffs (without `diff --git` headers) when a hunk removes a line starting with `--` next to an added line starting with `++`, so in-diff search and per-file patch exports no longer lose or misattribute lines.
