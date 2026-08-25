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
sidebar = "auto"
agent_notes = false
copy_decorations = false
transparent_background = false
cursor_line = "row"
```

`transparent_background` lets the terminal paint Hunk surfaces; turn it off when exact theme surfaces matter more than matching terminal transparency.

`cursor_line` chooses how the line you are on is marked: `row` highlights the whole row, `number` marks only its line number, and `off` removes the marker and returns `k` / `j` to scrolling the view one row at a time. Switch it mid-review from the View menu, or set `--cursor-line <style>` for a single run.
