---
title: Keyboard and mouse
description: Navigate, scroll, filter, and change Hunk's view without leaving the review.
---

Press `?` at any time for Hunk's in-app shortcut reference. Menus and primary review actions are also mouse-selectable.

## Navigate the review

| Keys                           | Action                                                |
| ------------------------------ | ----------------------------------------------------- |
| `↑` / `↓`, `k` / `j`           | Move the current line                                 |
| `Space` / `f`, `b`             | Page down / up                                        |
| `PageDown` / `PageUp`          | Page down / up                                        |
| `Shift+Space`                  | Page up                                               |
| `d` / `u`, `Ctrl+D` / `Ctrl+U` | Half page down / up                                   |
| `[` / `]`                      | Previous / next hunk                                  |
| `,` / `.`                      | Previous / next file                                  |
| `{` / `}`                      | Previous / next annotated hunk                        |
| `/`                            | Search diff content                                   |
| `n` / `N`                      | Next / previous search match                          |
| `Home` / `End`, `g` / `G`      | Start / end of review                                 |
| `←` / `→`                      | Scroll unwrapped code; hold Shift for faster movement |

Hunk navigation stays review-wide: hunk and file shortcuts move through the same multi-file stream shown in the main pane.

`/` opens a `less`-style prompt on the status row. Enter jumps to the next hunk containing the text (case-insensitive until the query has an uppercase letter), `n` / `N` repeat in either direction and wrap, the status row reports `[i/n] path:line`, and every match is marked inside the diff with the landed line inverted. Reopening `/` shows the last query: Escape clears it, and submitting the emptied prompt ends the search.

`↑` / `↓` and `k` / `j` move a highlighted current line, and the view scrolls only far enough to keep it visible. Paging or scrolling past it moves it to the nearest line still on screen, and `c` anchors a note on it. Pick the marker from the View menu, or set [`cursor_line`](/docs/configure/layout-and-display/): `number` marks only the line number, and `off` turns the marker off and lets `↑` / `↓` and `k` / `j` scroll the view one row at a time instead.

## Change the view

| Key             | Action                                           |
| --------------- | ------------------------------------------------ |
| `0` / `1` / `2` | Auto / unified / split layout                    |
| `s`             | Toggle files pane                                |
| `t`             | Choose a theme                                   |
| `l`             | Toggle line numbers                              |
| `w`             | Toggle line wrapping                             |
| `m`             | Toggle hunk metadata                             |
| `M`             | Toggle menu bar                                  |
| `z`             | Toggle unchanged context for the selected hunk   |
| `a`             | Toggle agent notes                               |
| `e`             | Open the selected file in `$EDITOR`              |
| `Tab`           | Move focus between the file list and file filter |
| `r`             | Reload a reloadable input                        |
| `F10`           | Open menus                                       |
| `q`             | Quit                                             |

Hunk may offer to save view changes on quit. Saving writes personal preferences globally unless the repository already has a `.hunk/config.toml`.

## Select, copy, and annotate

| Key             | Action                                         |
| --------------- | ---------------------------------------------- |
| `v`             | Start a visual selection from the current line |
| `y`             | Copy the selection                             |
| `c`             | Add a note on the current line                 |
| `Ctrl+S`        | Save the note you are editing                  |
| `E` / `R` / `D` | Edit, reply to, or delete the active note      |
| `?`             | Show every shortcut                            |

Press `c` or use a visible add-note affordance with the mouse. While editing, app shortcuts are suspended so normal text entry works. Press `Ctrl+S` to save or Escape to cancel.

Copying goes through the terminal clipboard protocol (OSC 52). If your terminal or multiplexer blocks it, Hunk reports that the clipboard is unavailable; see [terminal compatibility](/docs/help/compatibility/).

## Mouse behavior

- Click a sidebar file to jump to it in the review stream.
- Click menus and dialog actions instead of their key equivalents.
- Use the wheel or scrollbar to move through the review; hold Shift while scrolling to move horizontally through unwrapped code.
- Drag across diff rows to select them, then copy or comment from the selection's action bar.

## Remap the defaults

Every shortcut above is a named command you can move to different keys with a `[keybindings]` table in your user config. See [Keybindings](/docs/configure/keybindings/). The file filter ships without its own key (Tab and the File menu reach it); `"hunk.review.focusFilter" = "/"` moves it to `/`, which leaves content search without a key until you bind `hunk.search.find` elsewhere.

Terminal mouse protocols vary; see [terminal compatibility](/docs/help/compatibility/) if clicks or selection do not behave as expected.
