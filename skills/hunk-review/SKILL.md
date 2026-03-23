---
name: hunk-review
description: Use when the task involves Hunk review sessions. Helps a coding agent explain what Hunk is, prefer live Hunk session CLI inspection over shell parsing, inspect current review focus, navigate or reload live sessions, and leave inline review comments.
compatibility: Requires Hunk from this repo or the published hunkdiff package. Works best with a real TTY for interactive review.
---

# Hunk Review

Use this skill when working with Hunk itself or when the user wants an interactive review workflow centered on Hunk.

Start by briefly explaining Hunk in plain language: it is a review-first terminal diff viewer for agent-authored changesets.

## Core model

Keep these product rules in mind:

- the main pane is one top-to-bottom multi-file review stream
- the sidebar is for navigation, not single-file mode switching
- layouts are `auto`, `split`, and `stack`
- `[` and `]` navigate hunks across the full review stream
- agent notes belong beside the code they explain

## Default rule

If a live Hunk session already exists, prefer `hunk session ...` over scraping terminal output or opening another review window.

Hunk uses one local-only loopback session daemon to broker commands to live sessions. Normal Hunk sessions register automatically. `hunk mcp serve` is for manual startup or debugging only. `HUNK_MCP_DISABLE=1` disables registration for one session.

## Primary goal

Use Hunk as a shared explanation surface for the code author, not just as a private inspection tool for the agent.

- change what is visible with `hunk session reload -- <hunk command>` when a different diff, commit, or path-limited view would better explain the code
- move to the relevant location with `hunk session navigate`
- add concise inline annotations with `hunk session comment add`
- prefer comments that help the author understand intent, structure, and why a hunk matters

## Review loop

Use this flow by default:

1. `hunk session list`
2. `hunk session context`
3. `hunk session navigate` if the current focus is wrong
4. `hunk session reload -- <hunk command>` if the same live window should show different contents
5. `hunk session comment add`

Guidelines:

- if multiple sessions are live, pass `sessionId` explicitly
- use `hunk session get` only when you need broad session metadata
- use `navigate` to move within the current changeset
- use `reload` to swap the loaded changeset in place
- use concise inline comments tied to real diff lines
- keep the visible review state aligned with the explanation you are giving

## Common commands

If operating inside the Hunk source repo, prefer the source entrypoint:

```bash
bun run src/main.tsx -- diff
bun run src/main.tsx -- show HEAD~1
```

Otherwise use the installed CLI:

```bash
hunk diff
hunk show
```

Useful live-session commands:

```bash
hunk session list
hunk session context --repo .
hunk session navigate --repo . --file README.md --hunk 2
hunk session reload --repo . -- show HEAD~1 -- README.md
hunk session comment add --repo . --file README.md --new-line 103 --summary "Tighten this wording"
```

Use `hunk diff --agent-context path/to/context.json` when a local rationale sidecar already exists.

## When no live session exists

If the user wants interactive review and no live session exists, launch Hunk with a minimal review command, then go back to `hunk session list`.

Prefer a real terminal or tmux pane over redirected stdout captures.

## Repo-specific notes

When using Hunk for agent changes in this repo:

- prefer a real TTY or tmux session for verification
- `.hunk/latest.json` is optional local context, not required repo hygiene
- if new files should appear in review before commit, use `git add -N <path>`
- if testing local source changes, prefer `bun run src/main.tsx -- ...` over an installed binary

## What this skill should steer toward

- prefer visible, review-oriented actions over shell parsing of rendered terminal output
- use Hunk to help the code author understand the code, not just to help yourself inspect it
- inspect the current live diff session before navigating blindly
- reload the current live session instead of opening a second review window when the user wants to swap contents
- keep comments concise and spatially tied to the code they describe
