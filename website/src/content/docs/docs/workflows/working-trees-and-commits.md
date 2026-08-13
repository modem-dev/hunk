---
title: Working trees and commits
description: Review repository changes, staged work, refs, and path-limited changesets.
---

Use `diff` for working-copy or comparison input and `show` for one committed change.

## Review the working tree

```bash
hunk diff
```

For Git and Sapling working-copy reviews, Hunk includes untracked or unknown files by default. Exclude them explicitly:

```bash
hunk diff --exclude-untracked
```

Review only staged Git changes with either spelling:

```bash
hunk diff --staged
hunk diff --cached
```

## Compare against a target

```bash
hunk diff main
hunk diff main...feature -- src/core
```

Arguments after `--` are pathspecs; before `--`, the detected VCS interprets the target.

## Review a commit

```bash
hunk show
hunk show HEAD~2 -- README.md src/ui
```

`show` defaults to the latest commit. The loaded files still form one review stream, so path filtering changes the input rather than changing navigation behavior.

## Review a stash

In a Git repository, open a stash directly:

```bash
hunk stash show
hunk stash show stash@{2}
```

Staging areas and stashes are Git-only, so requesting them under another VCS fails with an error naming the unsupported operation.
