---
title: Keyboard and mouse
description: Navigate, scroll, filter, and change Hunk's view without leaving the review.
---

Press `?` at any time for Hunk's in-app shortcut reference. Menus and primary review actions are also mouse-selectable.

## Navigate the review

| Keys                      | Action                                                |
| ------------------------- | ----------------------------------------------------- |
| `↑` / `↓`, `k` / `j`      | Move in the focused pane                              |
| `Enter`                   | Focus the selected file's review                      |
| `Esc`                     | Focus the files pane                                  |
| `Space` / `f`, `b`        | Page down / up                                        |
| `Shift+Space`             | Page up                                               |
| `d` / `u`                 | Half page down / up                                   |
| `[` / `]`                 | Previous / next hunk                                  |
| `,` / `.`                 | Previous / next file                                  |
| `{` / `}`                 | Previous / next annotated hunk                        |
| `Home` / `End`, `g` / `G` | Start / end of review                                 |
| `←` / `→`                 | Scroll unwrapped code; hold Shift for faster movement |

Hunk navigation stays review-wide: hunk and file shortcuts move through the same multi-file stream shown in the main pane.

When the files pane and review are both visible, the focused pane uses a brighter border. Click a pane to focus it. `,` / `.` also focus the files pane; `[` / `]` focus the review. With the files pane focused and a file selected, `Enter` focuses that file's review; `Esc` returns to the files pane on the current file. With the files pane focused, `↑` / `↓` and `k` / `j` move between files, and in working-tree reviews they also land on folders; with the review focused they move a highlighted current line, and the view scrolls only far enough to keep it visible. Paging or scrolling past it moves it to the nearest line still on screen, and `c` anchors a note on it. Pick the marker from the View menu, or set [`cursor_line`](/docs/configure/layout-and-display/): `number` marks only the line number, and `off` turns the marker off and lets those keys scroll the view one row at a time instead.

## Change the view

| Key             | Action                                           |
| --------------- | ------------------------------------------------ |
| `0` / `1` / `2` | Auto / split / stack layout                      |
| `s`             | Toggle files pane                                |
| `t`             | Choose a theme                                   |
| `l`             | Toggle line numbers                              |
| `w`             | Toggle line wrapping                             |
| `m`             | Toggle hunk metadata                             |
| `M`             | Toggle menu bar                                  |
| `z`             | Toggle unchanged context for the selected hunk   |
| `a`             | Toggle agent notes                               |
| `e`             | Open the selected file in `$EDITOR`              |
| `/`             | Focus file filter                                |
| `Tab`           | Move focus between the file list and file filter |
| `r`             | Reload a reloadable input                        |
| `F10`           | Open menus                                       |
| `q`             | Quit                                             |

Hunk may offer to save view changes on quit. Saving writes personal preferences globally unless the repository already has a `.hunk/config.toml`.

## Add a human note

Press `c` on the selected hunk or use a visible add-note affordance with the mouse. While editing, app shortcuts are suspended so normal text entry works. Save with the note editor's displayed action or cancel with Escape.

## Mouse behavior

- Click a sidebar file to jump to it in the review stream and focus the files pane. Click a folder to select it; Space then stages or unstages the files shown under that folder. A folder stays on the current Unstaged/Staged side when any file under it belongs there. The files pane keeps +/- counts on every status row, including files that only have changes on the other tab.
- Click the review stream to focus it. The focused pane uses a brighter border.
- Click menus and dialog actions instead of their key equivalents.
- Use the wheel or scrollbar to move through the review; hold Shift while scrolling to move horizontally through unwrapped code.
- Select diff text for copy where the terminal supports it.

## Remap the defaults

Every shortcut above is a named command you can move to different keys with a `[keybindings]` table in your user config. See [Keybindings](/docs/configure/keybindings/).

Terminal mouse protocols vary; see [terminal compatibility](/docs/help/compatibility/) if clicks or selection do not behave as expected.
