---
title: Quick start
description: Open a working tree or commit and learn Hunk's review-first mental model.
---

Hunk presents every visible file in one review stream. The sidebar is an index into that stream, not a single-file mode.

## Review current work

From a repository:

```bash
hunk diff
```

This includes tracked changes and untracked files. Use `--exclude-untracked` when you intentionally want tracked changes only.

Inside Hunk:

1. Press `]` to jump to the next hunk.
2. Press `.` to jump to the next file.
3. Press `1`, `2`, or `0` for split, stack, or responsive auto layout.
4. Press `q` to quit.

![Hunk showing a multi-file review stream with a file sidebar, split diff rows, and restrained terminal chrome](/docs/images/review-stream.webp)

The sidebar indexes the same continuous stream shown in the main pane. Selecting a file jumps to it without hiding the rest of the changeset.

## Review a commit

```bash
hunk show          # latest commit
hunk show HEAD~1   # an earlier commit
```

A target is a Git ref or, in Jujutsu and Sapling workspaces, a native revset. Add path filtering after `--`:

```bash
hunk show HEAD~1 -- src/ui README.md
```

## Open the synchronized browser review

```bash
hunk diff --web
hunk diff --web --no-open
hunk diff --web --tailscale
hunk session open --repo .
```

`--web` uses Hunk's browser surface and keeps the owning process alive until you interrupt it; closing the tab does not stop a watched review. `--no-open` prints the one-session capability URL instead. Treat that URL as a secret. `--tailscale` adds a browser-only listener on the machine's Tailscale IPv4 address while keeping broker and session-control routes loopback-only; Tailscale must be installed and signed in. Renderer-specific OpenTUI extension sidebars and file views remain terminal-only in browser UI v1.

## Keep the review fresh

```bash
hunk diff --watch
hunk diff --watch --web
```

Hunk reloads file- and Git-backed input while preserving the review experience. Watch mode is continuous; interrupt the owning process when finished.

## Bring in an agent

Keep Hunk open, then in another terminal ask your coding agent to run `hunk skill path` and use the returned review skill. Continue with [Review with an agent](/docs/agents/review-with-an-agent/).
