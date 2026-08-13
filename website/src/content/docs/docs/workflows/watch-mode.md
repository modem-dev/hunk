---
title: Watch mode
description: Keep a file-backed or repository-backed review in sync as changes land.
---

Watch mode turns a review into a continuous view of a changing source.

## Start a watched review

```bash
hunk diff --watch
```

Hunk watches direct-file and Git-backed input and refreshes as soon as a change lands, with periodic polling as a fallback. Jujutsu and Sapling input relies on polling alone.

Other reopenable inputs also work:

```bash
hunk show HEAD~1 --watch
hunk diff before.ts after.ts --watch
hunk patch changes.patch --watch
```

## Know what can reload

Watch mode requires input Hunk can open again, so stdin-backed patches and stdin agent context cannot be watched:

```bash
# Snapshot only; --watch would fail
some-command | hunk patch -
```

Save changing output to a file or use a repository-backed command instead.

## Refresh manually

In a reloadable review, press `r` when you need an immediate refresh without continuous watch mode. A live agent can also use `hunk session reload` to replace the session's entire input.
