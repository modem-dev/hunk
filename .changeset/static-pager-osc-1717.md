---
"hunkdiff": minor
---

`hunk pager` now tags its static output with [OSC 1717 diff line metadata](https://github.com/stefanhaller/diff-line-metadata-spec) when the host asks for it through the `OSC1717` environment variable, so LazyGit 0.66+ keeps Hunk's rendering while you stage hunks and lines from its diff panel instead of falling back to Git's plain diff. Output without that variable is unchanged.
