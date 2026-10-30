---
title: Quick start
description: Open a working tree or commit and learn Hunk's review-first mental model.
---

Hunk presents every visible file in one review stream. The sidebar is an index into that stream, not a single-file mode.

## Review current work

From a repository:

```bash
hunk diff
```

This includes tracked changes and untracked files. Use `--exclude-untracked` when you intentionally want tracked changes only.

Inside Hunk:

1. Press `]` to jump to the next hunk.
2. Press `.` to jump to the next file.
3. Press `1`, `2`, or `0` for unified, split, or responsive auto layout.
4. Press `?` to see every shortcut.
5. Press `q` to quit.

![Hunk showing a multi-file review stream with a file sidebar, split diff rows, and restrained terminal chrome](/docs/images/review-stream.webp)

The sidebar indexes the same continuous stream shown in the main pane. Selecting a file jumps to it without hiding the rest of the changeset.

## Review a commit

```bash
hunk show          # latest commit
hunk show HEAD~1   # an earlier commit
```

A target is a Git ref or, in Jujutsu and Sapling workspaces, a native revset. Add path filtering after `--`:

```bash
hunk show HEAD~1 -- src/ui README.md
```

## Keep the review fresh

```bash
hunk diff --watch
```

Hunk reloads the review as files change and keeps your place in it. Press `q` when finished. See [Watch mode](/docs/workflows/watch-mode/) for which inputs can be watched.

## Bring in an agent

Install the review skill once:

```bash
npx skills add modem-dev/hunk -g --skill hunk-review
```

Keep Hunk open and ask your coding agent to walk you through the changes. Agent notes start hidden; press `a` to show them. Continue with [Review with an agent](/docs/agents/review-with-an-agent/).
