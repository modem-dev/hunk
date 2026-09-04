---
title: Git history
description: Read an attractive static Git history and open any commit in Hunk.
---

`hunk log` is Hunk's built-in, provider-neutral, static-first history surface. With the bundled Git
adapter it is a read-only alternative to `git log`. Its default `medium` format keeps
the familiar full commit id, author and email, authored date, complete message, branches, remotes,
and tags while adding a faithful graph and Hunk's visual hierarchy. It is an alternative entry
point into Hunk, not a repository dashboard or a replacement for Hunk's normal diff commands.

```bash
hunk log
hunk log -n 30
hunk log --all
hunk log main..feature
hunk log --first-parent
hunk log --author Ada --since 2.weeks
hunk log -- src/session
hunk log --oneline                 # compact rows
hunk log --format medium           # explicit default
```

The graph uses actual ordered parent ids. Ref labels decorate commits but do not assign commits to
branches. Redirected and piped output emits complete logical rows without cursor movement or
alternate-screen controls:

```bash
hunk log --color never > history.txt
hunk log --ascii | less
```

Decorations use familiar labels such as `(HEAD -> main, origin/main, tag: v0.21.0)` for both
lightweight and annotated tags. Color accepts `auto`, `always`, or `never`; automatic color respects
`NO_COLOR` and `TERM=dumb`. Dumb terminals also select the ASCII graph. `--theme <id>` selects the
same built-in or custom theme as Hunk review, including for `--color always` output. Hunk supports
the bundled Git adapter supports this deliberate subset rather than silently forwarding arbitrary
`git log` flags.

## Browse and open commits

Interaction is explicit so plain `hunk log` always remains predictable static output:

```bash
hunk log --interactive
```

The browser remains one minimal history list—there are no status, staging, branch, or preview
panes. Use:

- `Up`/`Down` or `j`/`k` to move
- `PageUp`/`PageDown`, `g`/`G`, or `Home`/`End` for larger jumps
- `/` to search and `n`/`N` for the next or previous match
- `y` to copy the full immutable commit id
- `Enter` to open the selected commit in Hunk's normal review
- `q` to quit

When you quit the opened review, Hunk returns to the retained history selection, viewport, and
search. Opening a commit starts a fresh review process, so review notes and drafts cannot leak from
one commit into another.

History enumeration and selected-item review semantics come from the public VCS adapter contract;
Hunk itself only presents and orchestrates them. The bundled Git adapter implements that contract
today. In jj or Sapling mode, select Git explicitly only when the checkout also has compatible Git
metadata:

```bash
hunk log --vcs git
```
