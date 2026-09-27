---
"hunkdiff": minor
---

Add a `terminal` theme that follows the terminal's own foreground, background, and ANSI palette for diffs, chrome, and syntax highlighting, and make it the default theme. Hunk re-reads the terminal's colors and repaints when the terminal reports a color-scheme change or on `SIGWINCH`, so switching terminal themes restyles a running Hunk.
