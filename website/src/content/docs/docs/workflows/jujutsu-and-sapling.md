---
title: Jujutsu and Sapling
description: Use native revsets and pager integration in jj and Sapling workspaces.
---

Hunk detects Git, Jujutsu (`jj`), and Sapling (`sl`) repositories. `hunk diff [target]` and `hunk show [target]` pass native revsets to the detected backend. See the concise [Jujutsu](/jujutsu/) and [Sapling](/sapling/) workflow overviews for a quick introduction.

## Jujutsu

```bash
hunk diff          # the working-copy change
hunk diff @-       # the changes inside @-, like `jj diff -r @-`
hunk diff @-- @    # compare two revisions
hunk show @
```

In Jujutsu, `hunk diff <revset>` shows the changes inside that revset. In Git and Sapling, `hunk diff <target>` compares your working copy against the target. Use `hunk diff <from> <to>` when you want a comparison in every backend.

Configure Hunk as jj's pager and request Git-format diffs:

```toml
[ui]
pager = ["hunk", "pager"]
diff-formatter = ":git"
```

Edit user settings with `jj config edit --user`.

## Sapling

```bash
hunk diff          # uncommitted changes
hunk diff .^       # working copy against the parent of `.`
hunk show .
```

Configure pager output with `sl config -u`:

```ini
[pager]
pager = hunk pager
```

## Override detection

In a colocated checkout (for example a jj repository with a `.git` directory), Hunk prefers Jujutsu, then Sapling, over Git. To choose a backend for one repository, set it in that repository's `.hunk/config.toml`:

```toml
vcs = "git" # git, jj, or sl
```

An explicit `vcs` always wins over detection, so avoid setting it in your user config: `vcs = "jj"` there would force Jujutsu in every Git repository. `vcs = "git"` in a colocated repository restores `--staged` and stash review.

Jujutsu and Sapling do not have Git's staging area, and stash review is Git-only. Their watch mode polls about every two seconds rather than observing repository files directly.
