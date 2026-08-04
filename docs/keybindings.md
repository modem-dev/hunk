# Keybindings

Every keyboard shortcut is a named command, and the `[keybindings]` table maps
command ids to the keys you want them on:

```toml
[keybindings]
"hunk.app.quit" = "ctrl+x"               # one chord
"hunk.review.nextHunk" = ["]", "ctrl+n"] # several chords for one command
"hunk.review.focusFilter" = "f"          # takes "f" away from page-down
"hunk.view.toggleMenuBar" = false        # unbind it entirely
"myext.toggle" = "ctrl+g"                # extension commands too
```

Every id starts with the name of whoever owns the command: Hunk's own commands
live under `hunk.`, and an extension's live under its extension id. That split
is structural — `hunk` is a reserved extension id, so an extension can never
mint a command id that shadows a built-in, whatever Hunk adds later.

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

| Command id                          | Does                                     | Default keys                 |
| ----------------------------------- | ---------------------------------------- | ---------------------------- |
| `hunk.app.quit`                     | Quit                                     | `q`                          |
| `hunk.app.refresh`                  | Refresh the review                       | `r`                          |
| `hunk.app.toggleHelp`               | Toggle help                              | `?`                          |
| `hunk.app.toggleFocusArea`          | Switch focus between files and filter    | `tab`                        |
| `hunk.app.openAgentSkill`           | Show agent skill                         | _(none)_                     |
| `hunk.review.focusFilter`           | Focus the file filter                    | `/`                          |
| `hunk.review.startNote`             | Add a review note                        | `c`                          |
| `hunk.review.editSelectedFile`      | Open the selected file in your editor    | `e`                          |
| `hunk.review.nextHunk`              | Next hunk                                | `]`                          |
| `hunk.review.previousHunk`          | Previous hunk                            | `[`                          |
| `hunk.review.nextFile`              | Next file                                | `.`                          |
| `hunk.review.previousFile`          | Previous file                            | `,`                          |
| `hunk.review.nextAnnotatedHunk`     | Next annotated hunk                      | `}`                          |
| `hunk.review.previousAnnotatedHunk` | Previous annotated hunk                  | `{`                          |
| `hunk.review.nextAnnotatedFile`     | Next annotated file                      | _(none)_                     |
| `hunk.review.previousAnnotatedFile` | Previous annotated file                  | _(none)_                     |
| `hunk.review.toggleHunkGap`         | Expand or collapse the selected context  | `z`                          |
| `hunk.review.pageDown`              | Scroll down one page                     | `pagedown`, `space`, `f`     |
| `hunk.review.pageUp`                | Scroll up one page                       | `pageup`, `b`, `shift+space` |
| `hunk.review.halfPageDown`          | Scroll down half a page                  | `d`                          |
| `hunk.review.halfPageUp`            | Scroll up half a page                    | `u`                          |
| `hunk.review.stepDown`              | Scroll down one row                      | `down`, `j`                  |
| `hunk.review.stepUp`                | Scroll up one row                        | `up`, `k`                    |
| `hunk.review.jumpToTop`             | Jump to start                            | `g`, `home`                  |
| `hunk.review.jumpToBottom`          | Jump to end                              | `G`, `end`                   |
| `hunk.review.scrollCodeLeft`        | Scroll code left (shifted scrolls fast)  | `left`, `shift+left`         |
| `hunk.review.scrollCodeRight`       | Scroll code right (shifted scrolls fast) | `right`, `shift+right`       |
| `hunk.review.selectOldSide`         | Select old side of current line          | `h`                          |
| `hunk.review.selectNewSide`         | Select new side of current line          | `l`                          |
| `hunk.view.toggleSidebar`           | Toggle sidebar                           | `s`                          |
| `hunk.view.toggleMenuBar`           | Toggle menu bar                          | `M`                          |
| `hunk.view.toggleHunkHeaders`       | Toggle hunk headers                      | `m`                          |
| `hunk.view.toggleLineNumbers`       | Toggle line numbers                      | _(none)_                     |
| `hunk.view.toggleLineWrap`          | Toggle line wrapping                     | `w`                          |
| `hunk.view.toggleAgentNotes`        | Toggle agent notes                       | `a`                          |
| `hunk.view.toggleCopyDecorations`   | Toggle copy decorations                  | _(none)_                     |
| `hunk.view.openThemeSelector`       | Choose theme                             | `t`                          |
| `hunk.view.layoutSplit`             | Split layout                             | `1`                          |
| `hunk.view.layoutStack`             | Stack layout                             | `2`                          |
| `hunk.view.layoutAuto`              | Auto layout                              | `0`                          |
| `hunk.view.cursorLineRow`           | Highlight the current row                | _(none)_                     |
| `hunk.view.cursorLineNumber`        | Mark the current line number             | _(none)_                     |
| `hunk.view.cursorLineOff`           | Hide the current-line marker             | _(none)_                     |

Commands marked _(none)_ ship without a key: they are menu items today, and
binding one gives it a shortcut like any other.

The menus and the controls help dialog (`?`) show the keys each command is
currently on, so remapping something changes what they advertise. A command you
unbind keeps its menu item and simply stops showing a key.

Extension commands are named `<extensionId>.<commandId>` and remap the same way
(see [docs/extensions.md](extensions.md)). Keys that belong to a dialog,
menu, or focused text input — `Esc`, `Enter`, `Ctrl-S` while writing a note —
are part of those widgets rather than commands, and are not remappable.

`[keybindings]` is read from your user config only — never from a repository's
`.hunk/config.toml`. Which keys do what is a property of your keyboard and your
habits, so a checkout you review cannot rearrange them.
