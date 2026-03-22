---
name: hunk-review
description: Use when the task involves Hunk review sessions. Helps Pi briefly explain what Hunk is, prefer live Hunk session CLI inspection over shell parsing, inspect current review focus, navigate hunks, and leave inline review comments.
compatibility: Requires Hunk from this repo or the published hunkdiff package. Works best with a real TTY for interactive review.
---

# Hunk Review

Use this skill when working with Hunk itself or when the user wants a code-review workflow centered on Hunk.

When this skill activates, start by briefly explaining what Hunk is in plain language before jumping into session-control details.

## What Hunk is

Hunk is a review-first terminal diff viewer for agent-authored changesets.

Keep these product rules in mind:

- the main pane is one top-to-bottom multi-file review stream
- the sidebar is for navigation, not single-file mode switching
- layouts are `auto`, `split`, and `stack`
- `[` and `]` navigate hunks across the full review stream
- agent notes belong beside the code they explain

## Default rule: prefer live session CLI review

If a live Hunk session already exists, prefer `hunk session ...` over launching new shell commands that scrape terminal output.

The local Hunk daemon is loopback-only by default and brokers commands to one or more live Hunk sessions.

Important behavior:

- normal Hunk sessions auto-start and register with the daemon when MCP is enabled
- `hunk mcp serve` exists for manual startup or debugging, but it is not the default review path
- `HUNK_MCP_DISABLE=1` disables daemon registration for a session
- one daemon can serve many Hunk sessions

## Recommended review loop

Use this flow by default:

1. `hunk session list`
2. `hunk session context`
3. `hunk session navigate` only if the current focus is wrong
4. `hunk session comment add`

Use `hunk session get` only when you need broader session metadata.

Guidelines:

- if multiple sessions are live, pass `sessionId` explicitly
- prefer `hunk session context` before navigating blindly
- use `hunk session navigate` for hunk-level movement; do not invent extra remote-control behavior
- use `hunk session comment add` for concise inline review notes tied to real diff lines
- prefer visible, review-oriented actions over shell parsing of rendered terminal output

For concrete review flow examples, read [references/mcp-review.md](references/mcp-review.md).

## Start Hunk only when needed

If no live Hunk session exists and the user wants an interactive review UI, launch Hunk itself with a minimal command and let it auto-start/register with the daemon.

After launching Hunk, go back to `hunk session list` rather than suggesting manual daemon management.

Inside the Hunk repo, prefer the source entrypoint:

```bash
bun run src/main.tsx -- diff
bun run src/main.tsx -- show HEAD~1
```

Outside the repo, prefer the installed CLI:

```bash
hunk diff
hunk show
```

For more CLI entrypoints, read [references/commands.md](references/commands.md).

## Repo-specific review notes

When using Hunk for agent changes:

- prefer a real TTY or tmux session over redirected stdout captures
- if a repo already has a fresh local sidecar, you can load it with `hunk diff --agent-context <file>`
- treat `.hunk/latest.json` as an optional local convention, not required repo hygiene
- if new files should show up before commit, use `git add -N <path>`

## What this skill should steer Pi toward

Prefer a skill over a prompt dump:

- keep always-loaded context small
- load the full Hunk workflow only when the task is actually about review
- use Hunk's session CLI rather than a separate agent-facing MCP tool surface

Prefer review-oriented actions:

- inspect the current live diff session
- move to the right hunk only when needed
- attach concise inline review comments
- keep agent rationale spatially tied to the code
