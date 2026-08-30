---
title: Watch mode
description: Keep a file-backed or repository-backed review in sync as changes land.
---

Watch mode turns a review into a continuous view of a changing source.

## Start a watched review

```bash
hunk diff --watch
```

Hunk observes direct-file and Git-backed inputs for prompt refreshes and keeps periodic polling as a fallback. It polls Jujutsu and Sapling input.

Other reopenable inputs also work:

```bash
hunk show HEAD~1 --watch
hunk diff --files before.ts after.ts --watch
hunk patch changes.patch --watch
```

## Know what can reload

Watch mode requires input Hunk can open again. Stdin-backed patches and stdin agent context cannot be watched:

```bash
# Snapshot only; --watch would fail
some-command | hunk patch -
```

Save changing output to a file or use a repository-backed command instead.

## Refresh manually

Press `r` for a reloadable review when you need an immediate refresh without continuous watch mode. A live agent can also use `hunk session reload` to replace the session's entire input.
