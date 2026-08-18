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
what terminals report. `ctrl+<letter>` also matches an unnamed bare control
byte; named Tab and Enter events stay distinct.

The built-in commands and the keys they ship with:

| Command id                                     | Does                                           | Default keys                 |
| ---------------------------------------------- | ---------------------------------------------- | ---------------------------- |
| `hunk.app.openAgentSkill`                      | Show agent skill                               | _(none)_                     |
| `hunk.app.quit`                                | Quit                                           | `q`                          |
| `hunk.app.refresh`                             | Refresh the review                             | `r`                          |
| `hunk.app.toggleFocusArea`                     | Switch focus between files and filter          | `tab`                        |
| `hunk.app.toggleHelp`                          | Toggle help                                    | `?`                          |
| `hunk.review.alignCurrentLineBottom`           | Align current line to viewport bottom          | _(none)_                     |
| `hunk.review.alignCurrentLineCenter`           | Center current line in viewport                | _(none)_                     |
| `hunk.review.alignCurrentLineTop`              | Align current line to viewport top             | _(none)_                     |
| `hunk.review.editSelectedFile`                 | Open the selected file in your editor          | `e`                          |
| `hunk.review.focusFilter`                      | Focus the file filter                          | `/`                          |
| `hunk.review.gotoLine`                         | Go to line                                     | `:`                          |
| `hunk.review.halfPageDown`                     | Scroll down half a page                        | `d`                          |
| `hunk.review.halfPageUp`                       | Scroll up half a page                          | `u`                          |
| `hunk.review.jumpToBottom`                     | Jump to end                                    | `G`, `end`                   |
| `hunk.review.jumpToTop`                        | Jump to start                                  | `g`, `home`                  |
| `hunk.review.nextAnnotatedFile`                | Next annotated file                            | _(none)_                     |
| `hunk.review.nextAnnotatedHunk`                | Next annotated hunk                            | `}`                          |
| `hunk.review.nextFile`                         | Next file                                      | `.`                          |
| `hunk.review.nextHunk`                         | Next hunk                                      | `]`                          |
| `hunk.review.pageDown`                         | Scroll down one page                           | `pagedown`, `space`, `f`     |
| `hunk.review.pageUp`                           | Scroll up one page                             | `pageup`, `b`, `shift+space` |
| `hunk.review.previousAnnotatedFile`            | Previous annotated file                        | _(none)_                     |
| `hunk.review.previousAnnotatedHunk`            | Previous annotated hunk                        | `{`                          |
| `hunk.review.previousFile`                     | Previous file                                  | `,`                          |
| `hunk.review.previousHunk`                     | Previous hunk                                  | `[`                          |
| `hunk.review.scrollCodeLeft`                   | Scroll code left (shifted scrolls fast)        | `left`, `shift+left`         |
| `hunk.review.scrollCodeRight`                  | Scroll code right (shifted scrolls fast)       | `right`, `shift+right`       |
| `hunk.review.startNote`                        | Add a review note                              | `c`                          |
| `hunk.review.stepDown`                         | Scroll down one row                            | `down`, `j`                  |
| `hunk.review.stepUp`                           | Scroll up one row                              | `up`, `k`                    |
| `hunk.review.toggleHunkGap`                    | Expand or collapse the selected context        | `z`                          |
| `hunk.view.applyFilePresentationToAllMatching` | Apply current file presentation to all matches | _(none)_                     |
| `hunk.view.cursorLineNumber`                   | Mark the current line number                   | _(none)_                     |
| `hunk.view.cursorLineOff`                      | Hide the current-line marker                   | _(none)_                     |
| `hunk.view.cursorLineRow`                      | Highlight the current row                      | _(none)_                     |
| `hunk.view.layoutAuto`                         | Auto layout                                    | `0`                          |
| `hunk.view.layoutSplit`                        | Split layout                                   | `1`                          |
| `hunk.view.layoutStack`                        | Stack layout                                   | `2`                          |
| `hunk.view.openThemeSelector`                  | Choose theme                                   | `t`                          |
| `hunk.view.toggleAgentNotes`                   | Toggle agent notes                             | `a`                          |
| `hunk.view.toggleCopyDecorations`              | Toggle copy decorations                        | _(none)_                     |
| `hunk.view.toggleFilesPane`                    | Toggle files pane                              | `s`                          |
| `hunk.view.toggleHunkHeaders`                  | Toggle hunk headers                            | `m`                          |
| `hunk.view.toggleLineNumbers`                  | Toggle line numbers                            | `l`                          |
| `hunk.view.toggleLineWrap`                     | Toggle line wrapping                           | `w`                          |
| `hunk.view.toggleMenuBar`                      | Toggle menu bar                                | `M`                          |

The files-pane command follows the named `hunk:files` role. If an extension
replaces that role, the command and **View → Files pane** toggle the resolved
replacement on any terminal edge without changing unrelated panes. Remapping or
unbinding `hunk.view.toggleFilesPane` changes that role-aware action, not an
extension pane's own commands. The former `hunk.view.toggleSidebar` id remains a
compatibility alias; prefer the files-pane name in new config and extension
code.

Commands marked _(none)_ ship without a key: they remain callable by command id
and can be assigned a shortcut through `[keybindings]`. Some also appear in a
menu, while semantic commands such as current-line alignment do not need a menu
entry.

The menus and the controls help dialog (`?`) show the keys for the commands they
present, so remapping something changes what they advertise. Unbinding a menu
command keeps its menu item and simply stops showing a key.

Extension commands are named `<extensionId>.<commandId>` and remap the same way
(see [docs/extensions.md](extensions.md)). An explicitly activated extension
keyboard mode is a routing layer rather than a second command table: it may
consume a key, pass it to these resolved bindings, or consume it and exit. Its
multi-key grammar and counts are extension-owned, but resolved actions should
invoke these same public `hunk.*` commands.

Routing precedence is host prompts and dialogs, menus/overlays, focused text
inputs, an interactive file-view mode, a session extension keyboard mode, then
the command table and focused review widget. Keys that belong to a dialog,
menu, or focused text input — `Esc`, `Enter`, `Ctrl-S` while writing a note —
are part of those widgets rather than commands, and are not remappable. Escape
is also the reserved exit from each active extension mode, so an extension
cannot trap the keyboard.

`[keybindings]` is read from your user config only — never from a repository's
`.hunk/config.toml`. Which keys do what is a property of your keyboard and your
habits, so a checkout you review cannot rearrange them.
