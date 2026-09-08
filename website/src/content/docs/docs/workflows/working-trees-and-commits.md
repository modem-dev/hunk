---
title: Working trees and commits
description: Review repository changes, staged work, refs, and path-limited changesets.
---

Use `diff` for working-copy or comparison input and `show` for one committed change. For a concise overview of Git-specific workflows, see [Hunk for Git](/git/).

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

Arguments after `--` are pathspecs. Before `--`, the target is interpreted by the detected VCS.

## Review a commit

```bash
hunk show
hunk show HEAD~2 -- README.md src/ui
```

`show` defaults to the latest commit. The loaded files still form one review stream, so path filtering changes the input rather than changing navigation behavior.

## Review a stash

Git repositories can open a stash directly:

```bash
hunk stash show
hunk stash show stash@{2}
```

Staging areas and stashes are Git-only. Hunk reports a focused error if these operations are requested under a VCS that does not support them.
