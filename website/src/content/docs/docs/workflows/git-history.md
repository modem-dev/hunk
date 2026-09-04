---
title: Repository history
description: Read attractive Git or Jujutsu history and open any commit in Hunk.
---

`hunk log` is Hunk's built-in, provider-neutral, static-first history surface. The bundled Git and
Jujutsu adapters both feed it through the public extension contract. Its default `medium` format
keeps the full commit id, author name and email, authored date, complete message, branches or bookmarks,
remotes, and tags while adding a faithful graph and Hunk's visual hierarchy. It is an alternative
entry point into Hunk, not a repository dashboard or a replacement for Hunk's normal diff commands.

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
lightweight and annotated tags. Jujutsu renders its working copy as `@`, local bookmarks as branch
labels, remote bookmarks as `name@remote`, and local or remote tags with `tag:`. Color accepts
`auto`, `always`, or `never`; automatic color respects `NO_COLOR` and `TERM=dumb`. Dumb terminals
also select the ASCII graph. `--theme <id>` selects the same built-in or custom theme as Hunk review,
including for `--color always` output. Each bundled adapter supports this deliberate common subset
rather than silently forwarding arbitrary provider flags.

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
- click a visible commit id to open it immediately, or double-click elsewhere on a row
- `q` to quit

When you quit the opened review, Hunk returns to the retained history selection, viewport, and
search. Opening a commit starts a fresh review process, so review notes and drafts cannot leak from
one commit into another.

History enumeration and selected-item review semantics come from the public VCS adapter contract;
Hunk itself only presents and orchestrates them. Jujutsu works directly in colocated and JJ-only
workspaces:

```bash
hunk log --vcs jj
hunk log --vcs jj '@::' --oneline
hunk log --vcs jj --first-parent --author Ada
```

Revision expressions and filtering retain the selected provider's meaning. In JJ mode, the optional
revision is a revset, `--all` starts from all visible heads, `--first-parent` uses first-parent
ancestry, path arguments are filesets, and author/message/date filters use JJ's matching rules.
JJ's single-revision diff supplies its native merged-parent baseline when an opened commit is a
merge. Sapling does not yet implement history and reports that capability as unsupported.
