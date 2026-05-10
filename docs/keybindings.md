# Keybindings

Hunk reads keybinding overrides from the same config files as every other view
preference: the global `~/.config/hunk/config.toml` and the repo-local
`.hunk/config.toml`. Repo settings take precedence over global ones, and CLI
flags do not affect the keymap.

Bindings are organized into four scopes that mirror the modes the app can be
in at any moment:

| Scope    | Active when                                       |
| -------- | ------------------------------------------------- |
| `global` | The main review UI is focused.                    |
| `pager`  | Hunk is invoked in pager mode (`hunk pager`).     |
| `menu`   | A menu (View, Theme, Agent, ...) is open.         |
| `filter` | The file-filter input is focused.                 |

Each scope is configured under its own TOML section, e.g.
`[keybindings.global]`. Missing keys keep their defaults; v1 has no "clear all"
switch.

Overrides REPLACE the default key list for an action — they do not merge.
For example, if you set `[keybindings.global] quit = "<c-q>"`, then `q`
no longer quits hunk; only Ctrl+Q does. To keep the default key alongside
your custom one, list both explicitly: `quit = ["q", "<c-q>"]`.

## Token syntax

Bindings accept either a single string or an array of strings:

```toml
[keybindings.global]
quit = "q"
"scroll.pageDown" = ["<space>", "f", "<pgdown>"]
```

Tokens use angle brackets for special keys and modifiers, mirroring lazygit:

| Token            | Meaning                                              |
| ---------------- | ---------------------------------------------------- |
| `q`, `?`, `[`    | Bare printable characters (literal sequence match).  |
| `<esc>`          | Escape key.                                          |
| `<tab>`          | Tab key.                                             |
| `<space>`        | Spacebar.                                            |
| `<enter>` / `<return>` | Enter (both spellings are equivalent).         |
| `<backspace>`    | Backspace.                                           |
| `<up>` / `<down>` / `<left>` / `<right>` | Arrow keys.                  |
| `<home>` / `<end>` | Home and End.                                      |
| `<pgup>` / `<pgdown>` | Page Up / Page Down.                            |
| `<f1>`–`<f12>`   | Function keys.                                       |
| `<c-c>`          | Ctrl+C.                                              |
| `<s-up>`         | Shift+Up.                                            |
| `<s-space>`      | Shift+Space — modifiers stack on any named key, not just arrows. |
| `<c-pgdown>`     | Ctrl+PageDown — same idea with a different modifier. |
| `<a-x>`, `<m-x>` | Alt+X / Meta+X.                                      |
| `<c-s-a>`        | Modifiers stack in any order.                        |
| `<disabled>`     | Sentinel that unbinds the action.                    |

Multi-key sequences like vim's `gg` are not supported in v1 — every binding is
a single chord.

To unbind a default:

```toml
[keybindings.global]
"sidebar.toggle" = "<disabled>"
```

Unknown action ids and malformed tokens are logged to stderr and otherwise
ignored. They never abort startup.

## Action reference

### `[keybindings.global]`

| Action               | Default keys              | What it does                  |
| -------------------- | ------------------------- | ----------------------------- |
| `scroll.lineDown`    | `j`, `<down>`             | Move line-by-line (down).     |
| `scroll.lineUp`      | `k`, `<up>`               | Move line-by-line (up).       |
| `scroll.pageDown`    | `<space>`, `f`, `<pgdown>` | Page down.                   |
| `scroll.pageUp`      | `b`, `<pgup>`, `<s-space>` | Page up.                     |
| `scroll.halfPageDown` | `d`                      | Half page down.               |
| `scroll.halfPageUp`  | `u`                       | Half page up.                 |
| `scroll.toTop`       | `<home>`                  | Jump to top of stream.        |
| `scroll.toBottom`    | `<end>`                   | Jump to bottom of stream.     |
| `scroll.codeLeft`    | `<left>`                  | Scroll code left one column.  |
| `scroll.codeRight`   | `<right>`                 | Scroll code right one column. |
| `scroll.codeLeftFast` | `<s-left>`               | Scroll code left (fast).      |
| `scroll.codeRightFast` | `<s-right>`             | Scroll code right (fast).     |
| `hunk.prev`          | `[`                       | Previous hunk.                |
| `hunk.next`          | `]`                       | Next hunk.                    |
| `annotatedHunk.prev` | `{`                       | Previous comment hunk.        |
| `annotatedHunk.next` | `}`                       | Next comment hunk.            |
| `layout.split`       | `1`                       | Split layout.                 |
| `layout.stack`       | `2`                       | Stack layout.                 |
| `layout.auto`        | `0`                       | Auto layout.                  |
| `sidebar.toggle`     | `s`                       | Toggle sidebar.               |
| `theme.cycle`        | `t`                       | Cycle theme.                  |
| `agentNotes.toggle`  | `a`                       | Toggle agent notes.           |
| `lineNumbers.toggle` | `l`                       | Toggle line numbers.          |
| `wrap.toggle`        | `w`                       | Toggle line wrap.             |
| `hunkHeaders.toggle` | `m`                       | Toggle hunk metadata headers. |
| `quit`               | `q`, `<esc>`              | Quit.                         |
| `help.toggle`        | `?`                       | Toggle help.                  |
| `filter.focus`       | `/`                       | Focus the file filter.        |
| `focus.toggle`       | `<tab>`                   | Toggle files/filter focus.    |
| `reload`             | `r`                       | Reload current input.         |
| `menu.open`          | `<f10>`                   | Open the menus.               |

### `[keybindings.pager]`

The pager scope mirrors the global scroll/wrap actions for `hunk pager`.
Defaults match the corresponding global actions; rebind them under this
section to override pager-only.

| Action                 | Default keys                | What it does                  |
| ---------------------- | --------------------------- | ----------------------------- |
| `quit`                 | `q`, `<esc>`                | Quit.                         |
| `scroll.lineDown`      | `j`, `<down>`               | Scroll one line down.         |
| `scroll.lineUp`        | `k`, `<up>`                 | Scroll one line up.           |
| `scroll.pageDown`      | `<space>`, `f`, `<pgdown>`  | Page down.                    |
| `scroll.pageUp`        | `b`, `<pgup>`, `<s-space>`  | Page up.                      |
| `scroll.halfPageDown`  | `d`                         | Half page down.               |
| `scroll.halfPageUp`    | `u`                         | Half page up.                 |
| `scroll.toTop`         | `<home>`                    | Jump to top.                  |
| `scroll.toBottom`      | `<end>`                     | Jump to bottom.               |
| `scroll.codeLeft`      | `<left>`                    | Scroll code left one column.  |
| `scroll.codeRight`     | `<right>`                   | Scroll code right one column. |
| `scroll.codeLeftFast`  | `<s-left>`                  | Scroll code left (fast).      |
| `scroll.codeRightFast` | `<s-right>`                 | Scroll code right (fast).     |
| `wrap.toggle`          | `w`                         | Toggle line wrap.             |
| `sidebar.toggle`       | `s`                         | Toggle sidebar.               |

### `[keybindings.menu]`

| Action          | Default keys             | What it does                |
| --------------- | ------------------------ | --------------------------- |
| `menu.close`    | `<esc>`                  | Close the menu.             |
| `menu.prev`     | `<left>`                 | Previous menu.              |
| `menu.next`     | `<right>`, `<tab>`       | Next menu.                  |
| `menu.itemUp`   | `<up>`                   | Previous item.              |
| `menu.itemDown` | `<down>`                 | Next item.                  |
| `menu.activate` | `<enter>`, `<return>`    | Activate current item.      |

### `[keybindings.filter]`

| Action         | Default keys | What it does               |
| -------------- | ------------ | -------------------------- |
| `focus.toggle` | `<tab>`      | Leave the filter input.    |

Esc and Enter inside the filter input are owned by the input element itself
(Esc clears, then closes; Enter submits) and are not configurable in v1.

## Example

```toml
# ~/.config/hunk/config.toml

[keybindings.global]
quit = ["q", "<c-c>"]
"sidebar.toggle" = "<disabled>"
"theme.cycle" = "<f5>"

[keybindings.pager]
"wrap.toggle" = "<c-w>"
```
