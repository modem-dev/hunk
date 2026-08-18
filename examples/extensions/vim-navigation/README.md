# Vim navigation extension

A small Vim-style normal mode for Hunk's whole review stream. It demonstrates session keyboard modes and public semantic command execution without accessing scroll boxes, renderer objects, or viewport coordinates.

This example is **not bundled or loaded by Hunk**. Install it explicitly if you want it.

## Try it from this checkout

```bash
bun run src/main.tsx -- diff --extension ./examples/extensions/vim-navigation
```

Press `F6` or choose **Extensions → Toggle Vim navigation**. The persistent status badge shows when the mode owns review-level keys; click the badge, choose the host-owned exit menu item, or press `Esc` to leave.

## Install it globally

```bash
mkdir -p ~/.config/hunk/extensions
cp -R examples/extensions/vim-navigation ~/.config/hunk/extensions/
```

## Keys

| Key                 | Action                                                      |
| ------------------- | ----------------------------------------------------------- |
| `j` / `k`           | Move the current review line down/up                        |
| `[` / `]`           | Move to the previous/next hunk                              |
| `gg` / `G`          | Jump to the start/end of the review                         |
| `zt` / `zz` / `zb`  | Align the current line at the top/center/bottom             |
| `Ctrl-D` / `Ctrl-U` | Move down/up by half pages                                  |
| positive digits     | Prefix the next relative motion, for example `5j` or `3]`   |
| `;`                 | Open the host-rendered Vim command line                     |
| `Esc`               | Exit the mode (host-owned; the extension never receives it) |
| everything else     | Pass through to normal Hunk routing                         |

Counts are parsed by the extension and capped at 10,000. Once a normal-mode sequence resolves, the extension calls `ctx.commands.execute(id, { count })` exactly once, so Hunk applies movement atomically. A bare `0` passes to Hunk's normal layout shortcut; `0` can extend a count that already began with `1`–`9`.

Pressing `;` passes the key to the example's registered command, which opens `ctx.dialogs.input()`. That focused host dialog captures typed keys ahead of the still-active session mode until Enter submits or Escape cancels. The deliberately small Ex-style command set is:

| Command   | Action                          |
| --------- | ------------------------------- |
| `:top`    | Jump to the start of the review |
| `:bottom` | Jump to the end of the review   |

Unsupported commands produce an attributed warning. Absolute source-line commands such as Vim's `:100` are intentionally absent because Hunk does not expose source-line targeting as a public semantic command; relative counted movement such as `100j` remains available in normal mode.

The example enables Hunk's host-owned current-line marker on entry so the `z*` alignment commands have a target. It resets all pending prefix/count state on entry and exit. Invalid continuations clear pending state and pass the current key back to Hunk.
