---
title: Repository history
description: Read attractive Git or Jujutsu history and open any commit in Hunk.
---

`hunk log` is Hunk's built-in, provider-neutral history surface. On a terminal it opens one
auto-responsive browser; pipes and redirects receive shell-native static output automatically. The
bundled Git and Jujutsu adapters both feed it through the public extension contract. Static output's
default `medium` format keeps the full commit id, author name and email, authored date, complete
message, branches or bookmarks, remotes, and tags while adding a faithful graph and Hunk's visual
hierarchy. It is an alternative entry point into Hunk, not a repository dashboard or a replacement
for Hunk's normal diff commands.

```bash
hunk log
hunk log -n 30
hunk log --all
hunk log main..feature
hunk log --first-parent
hunk log --author Ada --since 2.weeks
hunk log -- src/session
hunk log --static --oneline        # compact static records
hunk log --static --format medium  # explicit static default
hunk log --static                  # static output, paging when needed
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

Run plain `hunk log` on a terminal. The browser remains one minimal history list—there are no
status, staging, branch, or preview panes. Its File, View, Navigate, Commit, and Help menus reuse
Hunk's desktop chrome; press `F10` to open them. Rows adapt automatically: wide terminals show a
description and complete metadata on the left with the commit id and merge state aligned right;
medium and narrow terminals progressively remove secondary detail while keeping the title, identity,
and useful refs legible. Resizing changes information density without switching modes. The View
menu opens the same live-preview theme picker as review and offers session-local graph, Unicode,
author, date, and decoration controls. Use:

- `Up`/`Down` or `j`/`k` to move
- `PageUp`/`PageDown`, `g`/`G`, or `Home`/`End` for larger jumps
- `/` to search and `n`/`N` for the next or previous match
- `y` to copy the full immutable commit id
- `Enter` to open the selected commit in Hunk's normal review
- use Commit → **Compare with first parent** for the ordered first parent, or **Compare with parent…** to choose another merge parent; these compare the selected commit against that parent rather than opening the parent itself
- click a visible commit id to open it immediately, click its adjacent copy icon to copy the full immutable id, or double-click elsewhere on a row
- `r` to refresh while retaining the selected immutable commit when it still exists
- `q` to quit

Theme choices made in the browser carry into commits opened for review. While the fresh review
process prepares, the browser keeps terminal ownership and shows the selected commit in a loading
state; it yields only when review is ready to render, so previous shell output does not appear during
startup. When you quit the opened review, Hunk returns to the retained history selection, viewport,
and search. Opening a commit starts a fresh review process, so review notes and drafts cannot leak
from one commit into another.

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
