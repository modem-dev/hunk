---
"hunkdiff": patch
---

Fix session daemon auto-launch on Windows: the compiled binary's virtual `B:\~BUN\...` entrypoint was mistaken for a script path and passed to the relaunched daemon as a bogus argument, so `hunk session` commands never found a live session.
