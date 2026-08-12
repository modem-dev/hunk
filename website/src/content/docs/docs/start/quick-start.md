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
3. Press `1`, `2`, or `0` for split, stack, or responsive auto layout.
4. Press `q` to quit.

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

Watch mode keeps the review in sync as the input changes:

```bash
hunk diff --watch
```

As files or the repository change, Hunk reloads the input and preserves your place in the review. It runs until you press `q`.

## Bring in an agent

Keep Hunk open, then in another terminal ask your coding agent to run `hunk skill path` and use the returned review skill. Continue with [Review with an agent](/docs/agents/review-with-an-agent/).
