---
title: Layout and display
description: Control responsive structure, line treatment, review chrome, and note visibility.
---

Hunk uses the same normalized review model in every layout.

## Pick a layout policy

```bash
hunk diff --mode auto
hunk diff --mode split
hunk diff --mode stack
```

- `auto` chooses split on wide terminals and stack on narrow ones.
- `split` keeps before and after columns side by side.
- `stack` shows changed rows in a single-width flow.

Explicit split and stack choices override responsive behavior. Press `0`, `1`, or `2` to switch while reviewing.

## Tune code rows

```bash
hunk diff --no-line-numbers --wrap --no-hunk-headers --tab-width 2
```

Paired flags let scripts express either state: `--line-numbers` / `--no-line-numbers`, `--wrap` / `--no-wrap`, and `--hunk-headers` / `--no-hunk-headers`. Tab width accepts an integer from 1 through 16.

## Tune review chrome

TOML settings cover persistent display details:

```toml
mode = "auto"
line_numbers = true
wrap_lines = false
hunk_headers = true
menu_bar = true
agent_notes = false
copy_decorations = false
transparent_background = false
```

`transparent_background` lets the terminal paint Hunk surfaces; turn it off when exact theme surfaces matter more than matching terminal transparency.
