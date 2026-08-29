---
"hunkdiff": patch
---

Reject session reload inputs whose VCS `range` or `ref` values look like command options. A caller reaching the session broker could otherwise inject `git` flags such as `--output=<path>` through a `/session-api` reload request and make Hunk write diff output to an arbitrary path.
