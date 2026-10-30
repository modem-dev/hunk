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

Watch mode requires an interactive terminal and input Hunk can open again. Piped output, stdin-backed patches, and stdin agent context cannot be watched:

```bash
# Snapshot only; --watch would fail
some-command | hunk patch -
```

Save changing output to a file or use a repository-backed command instead.

## Turn it on by default

Put `watch = true` in the [command table](/docs/configure/configuration/#override-settings-for-a-command) for the reviews you want watched, not at the top level of your config:

```toml
[vcs]
watch = true
```

A top-level `watch = true` also applies to `hunk pager` and `hunk patch -`, which read stdin and cannot be watched, so those commands fail.

## Refresh manually

Press `r` for a reloadable review when you need an immediate refresh without continuous watch mode. A live agent can also use `hunk session reload` to replace the session's entire input.
