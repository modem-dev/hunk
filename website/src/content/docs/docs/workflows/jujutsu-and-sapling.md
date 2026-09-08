---
title: Jujutsu and Sapling
description: Use native revsets and pager integration in jj and Sapling workspaces.
---

Hunk detects Git, Jujutsu (`jj`), and Sapling (`sl`) repositories. `hunk diff [target]` and `hunk show [target]` pass native revsets to the detected backend. See the concise [Jujutsu](/jujutsu/) and [Sapling](/sapling/) workflow overviews for a quick introduction.

## Jujutsu

```bash
hunk diff
hunk diff @-
hunk show @
```

Configure Hunk as jj's pager and request Git-format diffs:

```toml
[ui]
pager = ["hunk", "pager"]
diff-formatter = ":git"
```

Edit user settings with `jj config edit --user`.

## Sapling

```bash
hunk diff
hunk diff .^
hunk show .
```

Configure pager output with `sl config -u`:

```ini
[pager]
pager = hunk pager
```

## Override detection

Set the backend in Hunk config when a checkout is ambiguous:

```toml
vcs = "jj" # git, jj, or sl
```

Jujutsu and Sapling do not have Git's staging area, and stash review is Git-only. Their watch mode currently polls rather than observing repository files directly.
