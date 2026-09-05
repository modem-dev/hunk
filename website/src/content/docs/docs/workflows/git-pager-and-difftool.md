---
title: Git pager and difftool
description: Use Hunk automatically for Git diff output or as an explicit Git difftool.
---

Pager mode inspects stdin: patch-like content opens the review UI, while ordinary pager text uses Hunk's plain-text fallback. To browse commit history directly, use the auto-responsive [`hunk log`](/docs/workflows/git-history) command instead; it does not change pager input detection.

## Configure the Git pager

```bash
git config --global core.pager "hunk pager"
```

Afterward, commands such as `git diff` and `git show` can open in Hunk. Git controls pager input, so untracked files are not synthesized in this mode.

Keep your normal pager and add opt-in aliases instead:

```bash
git config --global alias.hdiff '-c core.pager="hunk pager" diff'
git config --global alias.hshow '-c core.pager="hunk pager" show'
```

## Plain-text fallback

Output that is not a unified diff never opens the review UI; Hunk streams it to a plain-text pager instead. The pager command comes from `HUNK_TEXT_PAGER`, then `PAGER`, then falls back to `less -R`. A value that resolves back to `hunk` is ignored so Git can never recurse into `hunk pager` itself.

## Configure Git difftool

Tell Git how to invoke Hunk for each temporary file pair:

```bash
git config --global diff.tool hunk
git config --global difftool.hunk.cmd 'hunk difftool "$LOCAL" "$REMOTE" "$MERGED"'
git config --global difftool.prompt false
```

Then run:

```bash
git difftool
```

Difftool is pair-oriented because Git invokes the command once per file. Prefer `hunk diff` when you want Hunk's native full-changeset stream.

## Undo the integration

```bash
git config --global --unset core.pager
git config --global --remove-section difftool.hunk
```
