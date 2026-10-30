---
title: Agent context and STML
description: Load review notes from a JSON sidecar and opt into experimental rich note markup.
---

[Live agent comments](/docs/agents/comments-and-annotations/) are the recommended workflow. A sidecar file is useful when the notes already exist before Hunk starts, or need to travel with a patch.

## Load a JSON sidecar

```bash
hunk diff --agent-context notes.json
hunk patch change.patch --agent-context notes.json
```

Use `--agent-context -` to read the sidecar from stdin. With `--watch`, Hunk also reloads when the sidecar file changes, so an agent can rewrite the file and the open review updates; a stdin sidecar cannot be watched.

Sidecar annotations are agent notes, so they start hidden. Press `a` to show them, or launch with `--agent-notes`.

## Sidecar format

```json
{
  "version": 1,
  "files": [
    {
      "path": "src/search.ts",
      "summary": "Scores and sorts matches instead of returning the first substring hit.",
      "annotations": [
        {
          "newRange": [15, 35],
          "summary": "Prefix and exact matches now outrank weaker substring hits.",
          "rationale": "The old behavior made every match look equally good.",
          "author": "sonnet"
        }
      ]
    }
  ]
}
```

Top level:

| Field     | Type   | Notes                                                                            |
| --------- | ------ | -------------------------------------------------------------------------------- |
| `version` | number | Optional; defaults to `1`.                                                       |
| `summary` | string | Optional changeset summary. Extensions can read it; the TUI does not display it. |
| `files`   | array  | One entry per file you want to describe.                                         |

Each `files[]` entry:

| Field         | Type   | Notes                                                                         |
| ------------- | ------ | ----------------------------------------------------------------------------- |
| `path`        | string | Required. Matches the file's current path, or its previous path for a rename. |
| `summary`     | string | Optional. Used by the file filter, not shown as a card.                       |
| `annotations` | array  | Optional notes for this file.                                                 |

Each `annotations[]` entry:

| Field                                             | Type           | Notes                                                                                                                  |
| ------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `summary`                                         | string         | Required. The note's headline.                                                                                         |
| `newRange` / `oldRange`                           | `[start, end]` | Optional 1-based, inclusive line range on the new or old side. A note with no range attaches to the file's first hunk. |
| `rationale`                                       | string         | Optional longer explanation shown under the summary.                                                                   |
| `author`                                          | string         | Optional label for the card, such as `sonnet note`.                                                                    |
| `markup`                                          | string         | Optional [STML](#opt-into-stml) body. Ignored unless the session launched with `--experimental`.                       |
| `id`, `tags`, `confidence`, `source`, `createdAt` | various        | Optional metadata kept with the note. `confidence` is `low`, `medium`, or `high`.                                      |

Files listed in the sidecar appear first in the review, in sidecar order; other changed files follow in their usual order. Hunk rejects a sidecar with a missing `summary` or `path`, or a range whose end is before its start.

Keep it concise: short file summaries and only rationale that improves the review. A fuller example lives at [`examples/3-agent-review-demo/agent-context.json`](https://github.com/modem-dev/hunk/blob/main/examples/3-agent-review-demo/agent-context.json).

## Opt into STML

STML is experimental markup for richer note bodies: boxes, rows, badges, lists, and code. It is off by default and only the launch flag turns it on:

```bash
hunk --experimental diff --agent-context notes.json
```

A reload cannot turn STML on later, and there is no config key for it. Every note still needs a plain `summary`, which is the fallback whenever markup is unavailable. Without `--experimental`, a sidecar's `markup` is ignored and a live `--markup` comment is rejected.

Before sending markup, an agent should check support and width:

```bash
hunk session context --repo . --json
hunk markup guide
hunk markup render - --width <reported-noteMarkupWidth>
```

Only send `--markup` when `experimentalFeatures` includes `stml`. `hunk markup guide` prints the tag reference and copy-paste patterns. Keep colors symbolic and markup compact so notes stay close to their code.
