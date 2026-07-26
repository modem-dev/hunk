---
title: Files and patches
description: Compare two concrete files or open unified diff text from a file or stdin.
---

Use file comparison when you already have before and after content, and patch mode when another tool emits unified diff text.

## Compare files

```bash
hunk diff before.ts after.ts
```

When both operands are existing concrete files, Hunk treats them as a direct comparison instead of VCS targets. Add `--watch` to reload when either file changes:

```bash
hunk diff before.ts after.ts --watch
```

## Open a patch file

```bash
hunk patch changes.patch
```

A file-backed patch can use watch mode. It remains tied to that file path.

## Read a patch from stdin

```bash
git diff --no-color | hunk patch -
```

Use `-` to make stdin explicit. Stdin is a snapshot, so it cannot use `--watch`; write the patch to a file when you need continuous reloads.

Patch-like input is parsed into the same file and hunk model as repository input. Non-diff text belongs in [pager mode](/docs/workflows/git-pager-and-difftool/), where Hunk can fall back to plain text.
