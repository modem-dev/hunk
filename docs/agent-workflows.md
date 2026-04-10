# Agent workflows

Use Hunk with agents in two ways:

- **Recommended:** steer a live Hunk window from another terminal with `hunk session ...`
- **Alternative:** load prewritten agent notes from a file with `--agent-context`

## Recommended workflow: steer a live Hunk window

1. Open Hunk in one terminal with a normal review command such as `hunk diff` or `hunk show`.
2. Load the Hunk review skill: [`skills/hunk-review/SKILL.md`](../skills/hunk-review/SKILL.md).
3. Ask the agent to use the skill and review the current session.

> [!NOTE]
> `hunk skill path` lands in Hunk 0.10.0. Until that release is out, load the skill from the repo path above.

A good generic prompt is:

```text
Load the Hunk skill and use it for this review.
```

That skill teaches the agent how to inspect a live Hunk session, navigate it, reload it, and leave inline comments.

## How live session control works

When a Hunk TUI starts, it registers with a local loopback daemon. `hunk session ...` talks to that daemon to find the right live window and control it.

Most users only need `hunk session ...`. Use `hunk mcp serve` only for manual startup or debugging of the local daemon.

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
```

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

Use `--agent-context` when you already have agent-written rationale or notes in a JSON sidecar file and want to render them beside the diff.

```bash
hunk diff --agent-context notes.json
hunk patch change.patch --agent-context notes.json
```

For a compact real example, see [`examples/3-agent-review-demo/agent-context.json`](../examples/3-agent-review-demo/agent-context.json).

## Practical defaults

- start with `hunk session review --repo . --json`
- only add `--include-patch` when the raw patch is actually needed
- use `comment add` for one-off notes and `comment apply` for batches
- prefer `--repo` over `--session-path` unless you have a specific advanced reload case
