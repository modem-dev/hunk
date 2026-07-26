---
title: Keyboard and mouse
description: Navigate, scroll, filter, and change Hunk's view without leaving the review.
---

Press `?` at any time for Hunk's in-app shortcut reference. Menus and primary review actions are also mouse-selectable.

## Navigate the review

| Keys                      | Action                                                |
| ------------------------- | ----------------------------------------------------- |
| `↑` / `↓`, `k` / `j`      | Scroll one row                                        |
| `Space` / `f`, `b`        | Page down / up                                        |
| `d` / `u`                 | Half page down / up                                   |
| `[` / `]`                 | Previous / next hunk                                  |
| `,` / `.`                 | Previous / next file                                  |
| `{` / `}`                 | Previous / next annotated hunk                        |
| `Home` / `End`, `g` / `G` | Start / end of review                                 |
| `←` / `→`                 | Scroll unwrapped code; hold Shift for faster movement |

Hunk navigation stays review-wide: hunk and file shortcuts move through the same multi-file stream shown in the main pane.

## Change the view

| Key             | Action                      |
| --------------- | --------------------------- |
| `0` / `1` / `2` | Auto / split / stack layout |
| `s`             | Toggle sidebar              |
| `t`             | Choose a theme              |
| `l`             | Toggle line numbers         |
| `w`             | Toggle line wrapping        |
| `m`             | Toggle hunk metadata        |
| `a`             | Toggle agent notes          |
| `/`             | Focus file filter           |
| `r`             | Reload a reloadable input   |
| `q`             | Quit                        |

Hunk may offer to save view changes on quit. Saving writes personal preferences globally unless the repository already has a `.hunk/config.toml`.

## Add a human note

Press `c` on the selected hunk or use a visible add-note affordance with the mouse. While editing, app shortcuts are suspended so normal text entry works. Save with the note editor's displayed action or cancel with Escape.

## Mouse behavior

- Click a sidebar file to jump to it in the review stream.
- Click menus and dialog actions instead of their key equivalents.
- Use the wheel or scrollbar to move through the review.
- Select diff text for copy where the terminal supports it.

Terminal mouse protocols vary; see [terminal compatibility](/docs/help/compatibility/) if clicks or selection do not behave as expected.
