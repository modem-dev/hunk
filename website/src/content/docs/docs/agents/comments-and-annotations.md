---
title: Comments and annotations
description: Attach human or agent review notes to the code and navigate them in context.
---

Notes are hunk-specific and render beside the rows they explain. Hunk keeps them in the review flow rather than in a separate comments screen.

## Kinds of notes

| Term                   | What it is                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| **Note**               | Any card shown beside the code.                                                                      |
| **Agent comment**      | A note an agent adds to a live window with `hunk session comment`. This is the recommended path.     |
| **Sidecar annotation** | A note loaded at launch from an [`--agent-context` JSON file](/docs/agents/agent-context-and-stml/). |
| **Your note**          | A note you write in Hunk with `c`.                                                                   |
| **Highlight**          | A temporary mark on a character range. It draws attention but is not a note.                         |

Agent comments and sidecar annotations are both **agent notes**. They start hidden: press `a` to show or hide them, or launch with `--agent-notes`. Your own notes are always visible.

Notes live in the Hunk window. Closing the window discards them.

## Add one agent comment

```bash
hunk session comment add \
  --repo . \
  --file README.md \
  --new-line 103 \
  --summary "Tighten this wording" \
  --focus
```

Choose exactly one `--old-line` or `--new-line` target. `--focus` moves the user's viewport to the new note and turns agent notes on; use it for the first note in a session and when a note should actively steer the review.

Optional fields:

- `--rationale <text>`: a longer explanation shown under the summary.
- `--author <name>`: the label on the note card, such as `Claude note` instead of `Agent note`.
- `--markup <stml>`: an experimental rich body; see [Agent context and STML](/docs/agents/agent-context-and-stml/#opt-into-stml).

## Apply a batch

```bash
printf '%s\n' '{"comments":[{"filePath":"README.md","newLine":103,"summary":"Tighten this wording"}]}' \
  | hunk session comment apply --repo . --stdin --focus
```

Each item needs a `summary` and either:

- `filePath` with exactly one target: `hunk`, `hunkNumber`, `oldLine`, or `newLine`, or
- `replyTo` by itself, to reply to an existing note.

Items also accept `rationale`, `author`, and `markup`. Hunk validates the complete batch before changing the live session. `--focus` jumps to the first note in the batch.

## Reply to a note

A reply inherits the parent note's file and line:

```bash
hunk session comment add --repo . --reply-to user:123 --summary "Addressed in the latest revision"
```

## Hand your notes to the agent

Your notes are a way to ask the agent questions in context:

1. Press `c` on a line and write the question.
2. Ask your agent to read your notes. It runs `hunk session comment list --repo . --type user --json` or `hunk session review --repo . --include-notes --json`.
3. The agent answers with `--reply-to <note-id>`, and the reply appears under your note.

Agents can remove your notes during cleanup but cannot create or edit them.

## Inspect and clean up

```bash
hunk session comment list --repo .
hunk session comment list --repo . --type all
hunk session comment rm --repo . <comment-id>
hunk session comment clear --repo . --file README.md --yes
```

`comment list` shows agent comments by default. `--type` selects other notes:

| `--type`         | Lists                                         |
| ---------------- | --------------------------------------------- |
| `live` (default) | Comments added through `hunk session comment` |
| `user`           | Your notes                                    |
| `ai`             | Sidecar annotations                           |
| `agent`          | Agent-authored notes                          |
| `all`            | Every note                                    |

`comment clear` removes agent comments. Add `--all` (or its synonym `--include-user`) to clear your notes too. Clearing always requires `--yes`.

## Add your own note

In the TUI, move to a line and press `c`, or click an add-note affordance. Press `Ctrl+S` to save or Escape to cancel. Human and agent notes are labeled by source. Press `{` and `}` to move through annotated hunks across the review stream.
