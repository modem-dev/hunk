---
name: hunk-review
description: Interacts with live Hunk diff review sessions via CLI. Inspects review focus, navigates files and hunks, reloads session contents, and adds inline review comments. Use when the user has a Hunk session running or wants to review diffs interactively.
---

# Hunk Review

Hunk is an interactive terminal diff viewer. The TUI is for the user -- do NOT run `hunk diff`, `hunk show`, or other interactive commands directly. Use `hunk session *` CLI commands to inspect and control live sessions.

If no session exists, ask the user to launch Hunk in their terminal first.

## Workflow

```
1. hunk session list                    # find live sessions
2. hunk session context --repo .        # check current focus
3. hunk session navigate ...            # move to the right place
4. hunk session reload -- <command>     # swap contents if needed
5. hunk session comment add ...         # leave review notes
```

## Session selection

Every command (except `list`) needs a session target:

- `--repo <path>` -- match by repo root (most common)
- `<session-id>` -- match by exact ID (use when multiple sessions share a repo)
- If only one session exists, it auto-resolves

## Commands

### Inspect

```bash
hunk session list [--json]
hunk session get (--repo . | <id>) [--json]
hunk session context (--repo . | <id>) [--json]
```

### Navigate

Requires `--file` and exactly one of `--hunk`, `--new-line`, or `--old-line`:

```bash
hunk session navigate --repo . --file src/App.tsx --hunk 2
hunk session navigate --repo . --file src/App.tsx --new-line 372
hunk session navigate --repo . --file src/App.tsx --old-line 355
```

- `--hunk <n>` is 1-based
- `--new-line`/`--old-line` are 1-based line numbers on that diff side

### Reload

Swaps the live session's contents. Pass a Hunk review command after `--`:

```bash
hunk session reload --repo . -- diff
hunk session reload --repo . -- show HEAD~1
hunk session reload --repo . -- show HEAD~1 -- README.md
```

### Comments

```bash
hunk session comment add --repo . --file README.md --new-line 103 --summary "Tighten this wording" [--rationale "..."] [--author "agent"]
hunk session comment list --repo . [--file README.md]
hunk session comment rm --repo . <comment-id>
hunk session comment clear --repo . --yes [--file README.md]
```

- `comment add` requires `--file`, `--summary`, and exactly one of `--old-line` or `--new-line`
- Quote `--summary` and `--rationale` defensively in the shell

## New files in working-tree reviews

Newly created files won't appear in `hunk diff` until Git knows about them:

```bash
git add -N src/new-file.ts
hunk session reload --repo . -- diff
```

## Guiding a review

The user may ask you to walk them through a changeset or review code using Hunk. Your role is to narrate: steer the user's view to what matters and leave comments that explain what they're looking at.

Typical flow:

1. Load the right content (`reload` if needed)
2. Navigate to the first interesting file/hunk
3. Add a comment explaining what's happening and why
4. Move to the next point of interest -- repeat
5. Summarize when done

Guidelines:

- Work in the order that tells the clearest story, not necessarily file order
- Navigate before commenting so the user sees the code you're discussing
- Keep comments focused: intent, structure, risks, or follow-ups
- Don't comment on every hunk -- highlight what the user wouldn't spot themselves

## Common errors

- **"No visible diff file matches ..."** -- file isn't in the loaded review. Check `context`, then `reload` if needed.
- **"No active Hunk sessions"** -- ask the user to open Hunk in their terminal.
- **"Multiple active sessions match"** -- pass `<session-id>` explicitly.
- **"Specify exactly one navigation target"** -- pick one of `--hunk`, `--old-line`, `--new-line`.
