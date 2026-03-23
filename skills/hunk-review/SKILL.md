---
name: hunk-review
description: Use when the task involves Hunk review sessions. Helps a coding agent explain what Hunk is, prefer live Hunk session CLI inspection over shell parsing, inspect current review focus, navigate or reload live sessions, and leave inline review comments.
compatibility: Requires Hunk from this repo or the published hunkdiff package. Works best with a real TTY for interactive review.
---

# Hunk Review

Use this skill when the task involves Hunk itself or when the user wants an interactive review workflow centered on a live Hunk session.

Start by explaining Hunk plainly: **Hunk is a review-first terminal diff viewer for agent-authored changesets.**

## Mental model

Keep these product rules in mind:

- the main pane is one top-to-bottom multi-file review stream
- the sidebar is for navigation, not single-file mode switching
- layouts are `auto`, `split`, and `stack`
- `[` and `]` navigate hunks across the full review stream
- agent notes belong beside the code they explain

Your job is not just to inspect the diff privately. Use Hunk as a shared explanation surface for the code author.

## Default operating rule

If a live Hunk session already exists, prefer `hunk session ...` over scraping terminal output or opening another review window.

Hunk uses one local-only loopback daemon to broker commands to live sessions. Normal Hunk sessions register automatically. `hunk mcp serve` is for manual startup or debugging only. `HUNK_MCP_DISABLE=1` disables registration for one session.

## Default review workflow

Use this loop unless there is a strong reason not to:

1. `hunk session list`
2. `hunk session context`
3. `hunk session navigate` if the current focus is wrong
4. `hunk session reload -- <hunk command>` if the same live window should show different contents
5. `hunk session comment add`

Guidelines:

- if multiple sessions are live, pass `sessionId` explicitly
- use `--repo <path>` when you want the session whose repo root matches one checkout
- use `hunk session get` only when you need broad session metadata
- keep the visible review state aligned with the explanation you are giving
- prefer concise inline comments tied to real diff lines or hunks

## Precise command patterns

### Navigate precisely

Use exact `navigate` targets instead of guessing flags:

```bash
hunk session navigate --repo . --file README.md --hunk 2
hunk session navigate --repo . --file src/ui/App.tsx --new-line 372
hunk session navigate --repo . --file src/ui/App.tsx --old-line 355
```

Targeting rules:

- use `--hunk <n>` for a 1-based hunk number within the file
- use `--new-line <n>` for a line on the new side
- use `--old-line <n>` for a line on the old side
- do not invent extra flags; stick to the supported selectors above

### Add and manage comments

Use exact comment-management syntax:

```bash
hunk session comment add --repo . --file README.md --new-line 103 --summary "Tighten this wording"
hunk session comment list --repo . --file README.md
hunk session comment rm --repo . <comment-id>
hunk session comment rm <session-id> <comment-id>
```

When passing comment text through a shell, quote `--summary` and `--rationale` defensively. Avoid raw backticks unless you are sure the shell will not interpret them.

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

## Working-tree review playbook

For the common case of steering one live `hunk diff` session while local files are changing:

```bash
hunk session list
hunk session context --repo .
git add -N src/new-file.ts                 # if a new file is missing from the review
hunk session reload --repo . -- diff       # refresh the live working-tree review
hunk session navigate --repo . --file src/new-file.ts --hunk 1
hunk session comment add --repo . --file src/new-file.ts --new-line 10 --summary "Explain why this matters"
```

Important mental model:

- live session commands only operate on files visible in the currently loaded review
- for working-tree reviews, that means the file must appear in Git's diff
- newly created files often need `git add -N <path>` before Hunk can navigate to them or attach comments there

## Comment style

Prefer comments that help the author understand the change, not comments that just restate the diff.

Good comments usually do one of these:

- explain intent
- explain structure
- point out why one hunk matters to the rest of the change
- suggest a specific follow-up or risk to inspect

Keep comments concise and spatially tied to the code they describe.

## Common failure modes

- `No visible diff file matches ...`
  - the file is not part of the currently loaded review
  - check `hunk session context --repo .`
  - for a new file in a working-tree review, run `git add -N <path>` and then `hunk session reload --repo . -- diff`
- the session is showing the wrong changeset
  - use `hunk session reload --repo . -- diff`, `-- show ...`, or another nested Hunk review command
- navigation target is ambiguous
  - use one of `--hunk`, `--old-line`, or `--new-line`
- multiple live sessions exist and commands hit the wrong one
  - pass `sessionId` explicitly
- no live session exists yet
  - launch Hunk in a real terminal, then return to `hunk session list`

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
- inspect the current live diff session before navigating blindly
- reload the current live session instead of opening a second review window when the user wants to swap contents
- use Hunk to help the code author understand the code, not just to help yourself inspect it
- keep comments concise, concrete, and attached to the right place in the diff
