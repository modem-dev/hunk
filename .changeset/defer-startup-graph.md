---
"hunkdiff": patch
---

Start up faster for commands that never build a changeset. `hunk --version`, `--help`,
`daemon serve`, the markup commands, and `hunk session *` no longer load the VCS, extension, and
diff-engine graph before answering.
