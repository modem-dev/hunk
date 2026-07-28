# Keybindings

Every keyboard shortcut is a named command, and the `[keybindings]` table maps
command ids to the keys you want them on:

```toml
[keybindings]
"app.quit" = "ctrl+x"                 # one chord
"review.nextHunk" = ["]", "ctrl+n"]   # several chords for one command
"review.focusFilter" = "f"            # takes "f" away from page-down
"view.toggleMenuBar" = false          # unbind it entirely
"myext.toggle" = "ctrl+g"             # extension commands too
```

Rules worth knowing:

- **User bindings replace defaults.** Listing chords for a command is the
  complete set of keys it answers to, not an addition to the shipped ones.
- **A key you bind is yours.** Any command that held the same chord only as a
  default gives it up, keeping its other keys. Above, page-down still answers to
  `PageDown` and `Space` after `f` moves to the filter.
- **`false` (or `[]`) unbinds a command**, leaving its keys doing nothing.
- Two entries claiming one chord is a conflict: the first in the file wins and
  the session reports the other. Unknown command ids and unusable chords are
  reported the same way, and the rest of the table still applies.

Chords are `ctrl`, `alt`/`option`, `cmd`/`meta`, and `shift` joined with `+`
around a base key: a character (`"y"`, `"["`), an uppercase letter for its
shifted form (`"G"`), or a named key (`"tab"`, `"pageup"`, `"left"`, `"f2"`).
`shift` applies to letters and named keys only — for a shifted symbol or digit,
write the character the shift produces (`"!"`, not `"shift+1"`), since that is
what terminals report.

The built-in commands and the keys they ship with:

| Command id                     | Does                                     | Default keys                 |
| ------------------------------ | ---------------------------------------- | ---------------------------- |
| `app.quit`                     | Quit                                     | `q`                          |
| `app.refresh`                  | Refresh the review                       | `r`                          |
| `app.toggleHelp`               | Toggle help                              | `?`                          |
| `app.toggleFocusArea`          | Switch focus between files and filter    | `tab`                        |
| `review.focusFilter`           | Focus the file filter                    | `/`                          |
| `review.startNote`             | Add a review note                        | `c`                          |
| `review.editSelectedFile`      | Open the selected file in your editor    | `e`                          |
| `review.nextHunk`              | Next hunk                                | `]`                          |
| `review.previousHunk`          | Previous hunk                            | `[`                          |
| `review.nextFile`              | Next file                                | `.`                          |
| `review.previousFile`          | Previous file                            | `,`                          |
| `review.nextAnnotatedHunk`     | Next annotated hunk                      | `}`                          |
| `review.previousAnnotatedHunk` | Previous annotated hunk                  | `{`                          |
| `review.toggleHunkGap`         | Expand or collapse the selected context  | `z`                          |
| `review.pageDown`              | Scroll down one page                     | `pagedown`, `space`, `f`     |
| `review.pageUp`                | Scroll up one page                       | `pageup`, `b`, `shift+space` |
| `review.halfPageDown`          | Scroll down half a page                  | `d`                          |
| `review.halfPageUp`            | Scroll up half a page                    | `u`                          |
| `review.stepDown`              | Scroll down one row                      | `down`, `j`                  |
| `review.stepUp`                | Scroll up one row                        | `up`, `k`                    |
| `review.jumpToTop`             | Jump to start                            | `g`, `home`                  |
| `review.jumpToBottom`          | Jump to end                              | `G`, `end`                   |
| `review.scrollCodeLeft`        | Scroll code left (shifted scrolls fast)  | `left`, `shift+left`         |
| `review.scrollCodeRight`       | Scroll code right (shifted scrolls fast) | `right`, `shift+right`       |
| `view.toggleSidebar`           | Toggle sidebar                           | `s`                          |
| `view.toggleMenuBar`           | Toggle menu bar                          | `M`                          |
| `view.toggleHunkHeaders`       | Toggle hunk headers                      | `m`                          |
| `view.toggleLineNumbers`       | Toggle line numbers                      | `l`                          |
| `view.toggleLineWrap`          | Toggle line wrapping                     | `w`                          |
| `view.toggleAgentNotes`        | Toggle agent notes                       | `a`                          |
| `view.openThemeSelector`       | Choose theme                             | `t`                          |
| `view.layoutSplit`             | Split layout                             | `1`                          |
| `view.layoutStack`             | Stack layout                             | `2`                          |
| `view.layoutAuto`              | Auto layout                              | `0`                          |

Extension commands are named `<extensionId>.<commandId>` and remap the same way
(see [docs/extensions.md](extensions.md)). Keys that belong to a dialog,
menu, or focused text input — `Esc`, `Enter`, `Ctrl-S` while writing a note —
are part of those widgets rather than commands, and are not remappable.

`[keybindings]` is read from your user config only — never from a repository's
`.hunk/config.toml`. Which keys do what is a property of your keyboard and your
habits, so a checkout you review cannot rearrange them.
