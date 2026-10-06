---
title: Files and patches
description: View complete files, browse directories, compare concrete files, or review patches.
---

Use file comparison when you already have before and after content, and patch mode when another tool emits unified diff text.

## View a complete file or directory

```bash
hunk open                # browse the current directory
hunk open README.md      # syntax-highlighted complete document
hunk open path/to/project
```

No repository or changeset is required. The read-only browser lazy-loads expanded directories and
selected documents, and watches them for changes. Arrow keys and Enter navigate the tree; Tab
switches tree/document focus. Mouse clicks select files and expand folders. Press `i` to show
hidden and Git-ignored entries, `e` to open the displayed file in `$EDITOR`, `t` for themes,
`w` for wrapping, and `?` for controls. Commands can be remapped in user configuration.

Symlinks are listed but never followed. Binary/non-UTF-8, unreadable, missing, or files over
1 MiB show a placeholder. Extremely large directories are bounded to 10,000 entries. Only one
path is accepted; stdin, multiple paths, and `file:line` are not supported yet. `open` does not
load user extensions or register a review session with the agent broker.

## Compare files

```bash
hunk diff --files before.ts after.ts
```

The explicit `--files` option keeps file comparison distinct from `hunk diff <from> <to>`, which compares two VCS revisions. Add `--watch` to reload when either file changes:

```bash
hunk diff --files before.ts after.ts --watch
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
