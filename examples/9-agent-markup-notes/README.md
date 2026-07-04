# 9 — agent markup notes (STML)

Shows agent notes that carry **STML markup** — a small HTML-like markup that
Hunk renders as real terminal UI inside the inline note card: bordered boxes,
rows of shapes, lists, badges, and code blocks instead of plain text.

Run from the repository root:

```sh
hunk patch examples/9-agent-markup-notes/change.patch \
  --agent-context examples/9-agent-markup-notes/agent-context.json
```

Press `a` to reveal the agent notes for the selected hunk.

The same markup works for live comments from an agent driving a session:

```sh
hunk session comment add --repo . --file src/retry.ts --new-line 3 \
  --summary "Retry flow" \
  --markup '<box border border-color="accent">shapes in a note</box>' \
  --focus
```

Learn and iterate from the CLI:

```sh
hunk markup guide                                  # authoring guide with copy-paste patterns
echo '<badge color="success">OK</badge> ready' | \
  hunk markup render - --width 56                  # preview before publishing
```

Tags: block (`box`, `card`, `row`, `text`, `h1`–`h3`, `list`/`item`, `hr`,
`spacer`, `code`) and inline (`b`, `i`, `u`, `s`, `dim`, `color`, `kbd`,
`badge`, `a`, `br`). Colors accept semantic tokens (`accent`, `success`,
`warning`, `danger`, `info`, `muted`), ANSI-style names, or hex.
