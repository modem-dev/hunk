# Agent workflows

Use Hunk with agents in two ways:

- **Recommended:** steer a live Hunk window from another terminal with `hunk session ...`
- **Alternative:** load prewritten agent notes from a file with `--agent-context`

## Recommended workflow: steer a live Hunk window

1. Open Hunk in one terminal with a normal review command such as `hunk diff` or `hunk show`.
2. Load the Hunk review skill: [`skills/hunk-review/SKILL.md`](../skills/hunk-review/SKILL.md).
3. Ask the agent to use the skill and review the current session.

A good generic prompt is:

```text
Load the Hunk skill and use it for this review. Run `hunk skill path` to get the skill path.
```

That skill teaches the agent how to inspect a live Hunk session, navigate it, reload it, and leave inline comments.

## How live session control works

When a Hunk TUI starts, it registers with a local loopback daemon. `hunk session ...` talks to that daemon to find the right live window and control it.

Most users only need `hunk session ...`. Use `hunk mcp serve` only for manual startup or debugging of the local daemon.

If `hunk session list` reports no sessions while Hunk is visibly running, the agent sandbox may be blocking loopback access. Probe the daemon directly:

```bash
curl -s -X POST http://127.0.0.1:47657/session-api \
  -H 'content-type: application/json' \
  --data '{"action":"list"}'
```

If this shows sessions, rerun the command with the agent's network/sandbox escalation. If you run the daemon with a custom `HUNK_MCP_PORT`, use that port instead.

## The commands you will use most

### Inspect the current review

Start here before navigating or commenting:

```bash
hunk session list
hunk session get --repo .
hunk session review --repo . --json
```

- `list` shows the active Hunk windows
- `get --repo .` confirms which live session matches the current repo
- `review --json` returns the loaded file and hunk structure without dumping the full raw patch

Only add `--include-patch` when an agent truly needs raw unified diff text:

```bash
hunk session review --repo . --include-patch --json
```

### Move the live window to the right place

Use `navigate` to jump to the file or hunk you want the user to see:

```bash
hunk session navigate --repo . --file src/App.tsx --hunk 2
hunk session navigate --repo . --next-comment
```

Use `reload` when you want the already-open Hunk window to show a different diff or commit:

```bash
hunk session reload --repo . -- diff
hunk session reload --repo . -- show HEAD~1 -- README.md
```

Notes:

- always include `--` before the nested Hunk command in `reload`
- `--hunk` is 1-based
- `--next-comment` and `--prev-comment` are handy when an agent is walking the user through existing notes

### Add comments

For one note, use `comment add`:

```bash
hunk session comment add --repo . --file README.md --new-line 103 --summary "Tighten this wording"
```

For multiple notes, use one stdin batch with `comment apply`:

```bash
printf '%s\n' '{"comments":[{"filePath":"README.md","newLine":103,"summary":"Tighten this wording"}]}' \
  | hunk session comment apply --repo . --stdin
```

`comment apply` payload items need:

- `filePath`
- `summary`
- exactly one target such as `hunk`, `hunkNumber`, `oldLine`, or `newLine`

If you want the UI to jump to the new note, add `--focus` to `comment add` or `comment apply`.

For comment cleanup and inspection, use:

```bash
hunk session comment list --repo .
hunk session comment rm --repo . <comment-id>
hunk session comment clear --repo . --file README.md --yes
hunk session comment clear --repo . --all --yes # also clears human `c` notes
```

Agents can remove or bulk-clear human notes for cleanup, but cannot create or edit them through the session CLI.

## Session targeting

Most commands can target the live session in a few ways:

- `--repo <path>`: most common; matches the live session by its current repo root
- `<session-id>`: useful when multiple Hunk windows are open for the same repo
- if only one session exists, Hunk can auto-resolve it

`reload` also supports some advanced selectors:

- `--session-path <path>` targets the live Hunk window by its current working directory
- `--source <path>` changes where the replacement `diff` or `show` command runs

For normal worktree use, prefer `--repo /path/to/worktree`. Reach for `--session-path` and `--source` only when you need to repoint an already-open window to another checkout or path.

## Alternative workflow: load agent comments from a file

Use `--agent-context` when you already have agent-written rationale or notes in a JSON file and want to render them beside the diff.

```bash
hunk diff --agent-context notes.json
hunk patch change.patch --agent-context notes.json
```

For a compact real example, see [`examples/3-agent-review-demo/agent-context.json`](../examples/3-agent-review-demo/agent-context.json).

### agent-context JSON format

The `--agent-context` file has the following top-level fields:

| Field         | Type     | Description                                                                                                                                      |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`     | `number` | Schema version. Use `1`.                                                                                                                         |
| `title`       | `string` | Optional. A one-line PR-style changeset title shown in the Overview overlay header.                                                              |
| `description` | `string` | Optional. A markdown body for the Overview overlay (headings, lists, bold/italic, inline `code`, fenced code blocks, blockquotes, rules, links). |
| `summary`     | `string` | Optional. Legacy plain-text changeset summary. Used as the Overview body when `description` is absent (`description ?? summary`).                |
| `files`       | `array`  | Per-file annotations. Each entry has `path`, optional `summary`, and an `annotations` array of hunk-level notes.                                 |

When the agent sets a `title` or `description`, the Overview overlay auto-opens once when the session starts. A file with only a legacy `summary` does not auto-open, but its summary is still shown as the overview body when you open the overlay yourself. Press `o` to toggle the overlay or `Esc` to close it. The overlay is also accessible from the Agent menu.

A minimal file with the new fields looks like:

```json
{
  "version": 1,
  "title": "feat(search): ranked command-palette matching",
  "description": "## Overview\n\nThis changeset introduces a ranked scoring model.\n\n- `normalize.ts` — shared query normalization\n- `search.ts` — score-based sorting\n\nPrefix and exact matches now outrank loose substring hits.",
  "files": [
    {
      "path": "src/search.ts",
      "annotations": [
        {
          "newRange": [15, 35],
          "summary": "Scores and sorts results instead of returning the first substring list.",
          "rationale": "Ensures the most obvious intent appears at the top of the palette.",
          "author": "sonnet"
        }
      ]
    }
  ]
}
```

## Practical defaults

- start with `hunk session review --repo . --json`
- only add `--include-patch` when the raw patch is actually needed
- use `comment add` for one-off notes and `comment apply` for batches
- prefer `--repo` over `--session-path` unless you have a specific advanced reload case
