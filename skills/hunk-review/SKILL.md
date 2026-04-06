---
name: hunk-review
description: Interacts with live Hunk diff review sessions via CLI. Inspects review focus, navigates files and hunks, reloads session contents, and adds inline review comments. Use when the user has a Hunk session running or wants to review diffs interactively.
---

# Hunk Review

Hunk is an interactive terminal diff viewer. The TUI is for the user -- do NOT run `hunk diff`, `hunk show`, or other interactive commands directly. Use `hunk session *` CLI commands to inspect and control live sessions through the local daemon.

If no session exists, ask the user to launch Hunk in their terminal first.

## Workflow

```text
1. hunk session list                    # find live sessions
2. hunk session get --repo .            # inspect path / repo / source
3. hunk session context --repo .        # check current focus
4. hunk session navigate ...            # move to the right place
5. hunk session reload -- <command>     # swap contents if needed
6. hunk session comment add ...         # leave one review note
7. hunk session comment apply ...       # apply many agent notes in one stdin batch
```

## Session selection

Most session commands accept:

- `--repo <path>` -- match the live session by its current loaded repo root (most common)
- `<session-id>` -- match by exact ID (use when multiple sessions share a repo)
- If only one session exists, it auto-resolves

`reload` also supports:

- `--session-path <path>` -- match the live Hunk window by its current working directory
- `--source <path>` -- load the replacement `diff` / `show` command from a different directory

Use `--source` only for advanced reloads where the live session you want to control is not already associated with the checkout you want to load next. For a normal worktree session, prefer selecting it directly with `--repo /path/to/worktree`.

## Commands

### Inspect

```bash
hunk session list [--json]
hunk session get (--repo . | <id>) [--json]
hunk session context (--repo . | <id>) [--json]
```

- `get` shows the session `Path`, `Repo`, and `Source`, which helps when choosing between `--repo` and `--session-path`
- `Repo` is what `--repo` matches; `Path` is what `--session-path` matches

### Navigate

Absolute navigation requires `--file` and exactly one of `--hunk`, `--new-line`, or `--old-line`:

```bash
hunk session navigate --repo . --file src/App.tsx --hunk 2
hunk session navigate --repo . --file src/App.tsx --new-line 372
hunk session navigate --repo . --file src/App.tsx --old-line 355
```

Relative comment navigation jumps between annotated hunks and does not require `--file`:

```bash
hunk session navigate --repo . --next-comment
hunk session navigate --repo . --prev-comment
```

- `--hunk <n>` is 1-based
- `--new-line` / `--old-line` are 1-based line numbers on that diff side
- Use either `--next-comment` or `--prev-comment`, not both

### Reload

Swaps the live session's contents. Pass a Hunk review command after `--`:

```bash
hunk session reload --repo . -- diff
hunk session reload --repo . -- diff main...feature -- src/ui
hunk session reload --repo . -- show HEAD~1
hunk session reload --repo . -- show HEAD~1 -- README.md
hunk session reload --repo /path/to/worktree -- diff
hunk session reload --session-path /path/to/live-window --source /path/to/other-checkout -- diff
```

- Always include `--` before the nested Hunk command
- `--repo` or `<session-id>` usually selects the session you want
- `--source` is advanced: it does not select the session; it only changes where the replacement review command runs
- If the live session is already showing the target worktree, prefer `hunk session reload --repo /path/to/worktree -- diff`
- `--session-path` targets the live window when you need to keep session selection separate from reload source

### Comments

```bash
hunk session comment add --repo . --file README.md --hunk 2 --summary "Explain the hunk" [--rationale "..."] [--author "agent"] [--focus]
hunk session comment add --repo . --file README.md --new-line 103 --summary "Tighten this wording" [--rationale "..."] [--author "agent"] [--focus]
printf '%s\n' '{"comments":[{"filePath":"README.md","hunk":2,"summary":"Explain the hunk"}]}' | hunk session comment apply --repo . --stdin [--focus]
hunk session comment list --repo . [--file README.md]
hunk session comment rm --repo . <comment-id>
hunk session comment clear --repo . --yes [--file README.md]
```

- `comment add` is best for one note; `comment apply` is best when an agent already has several notes ready
- `comment add` requires `--file`, `--summary`, and exactly one of `--hunk`, `--old-line`, or `--new-line`
- `comment apply` payload items require `filePath`, `summary`, and one target such as `hunk`, `oldLine`, or `newLine`
- Prefer `--hunk <n>` when you want to annotate the whole diff hunk instead of picking a single line manually
- `comment add` and `comment apply` both keep the current focus by default; pass `--focus` when you want to jump to the new note or the first note in a batch
- `comment apply` reads a JSON batch from stdin and validates the full batch before mutating the live session
- `comment list` and `comment clear` accept optional `--file`
- Quote `--summary` and `--rationale` defensively in the shell

## New files in working-tree reviews

`hunk diff` includes untracked files by default. If the user wants tracked changes only, reload with `--exclude-untracked`:

```bash
hunk session reload --repo . -- diff --exclude-untracked
```

## Guiding a review

The user may ask you to walk them through a changeset or review code using Hunk. Your role is to narrate: steer the user's view to what matters and leave comments that explain what they're looking at.

Typical flow:

1. Load the right content (`reload` if needed)
2. Navigate to the first interesting file / hunk
3. Add a comment explaining what's happening and why
4. If you already have several notes ready, prefer one `comment apply` batch over many separate shell invocations
5. Summarize when done

Guidelines:

- Work in the order that tells the clearest story, not necessarily file order
- Navigate before commenting so the user sees the code you're discussing
- Use `comment apply` for agent-generated batches and `comment add` for one-off notes
- Keep comments focused: intent, structure, risks, or follow-ups
- Don't comment on every hunk -- highlight what the user wouldn't spot themselves

## Common errors

- **"No visible diff file matches ..."** -- the file is not in the loaded review. Check `context`, then `reload` if needed.
- **"No active Hunk sessions"** -- ask the user to open Hunk in their terminal.
- **"Multiple active sessions match"** -- pass `<session-id>` explicitly.
- **"No active Hunk session matches session path ..."** -- for advanced split-path reloads, verify the live window `Path` via `hunk session get` or `list`, then use `--session-path`.
- **"Pass the replacement Hunk command after `--`"** -- include `--` before the nested `diff` / `show` command.
- **"Specify exactly one navigation target"** -- pick one of `--hunk`, `--old-line`, or `--new-line`.
- **"Specify either --next-comment or --prev-comment, not both."** -- choose one comment-navigation direction.
- **"Pass --stdin to read batch comments from stdin JSON."** -- `comment apply` only reads its batch payload from stdin.
