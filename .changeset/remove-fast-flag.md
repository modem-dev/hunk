---
"hunkdiff": minor
---

Remove the `--fast` flag, which has been a no-op since 0.24.0 made worker highlighting the default. Drop `--fast` from shell aliases, scripts, and pager configs such as Git's `core.pager` or LazyGit; Hunk now rejects it as an unknown option or command.
