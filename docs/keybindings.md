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
byte; named Tab and Enter events stay distinct. `alt`/`option` matches both
explicit Alt events and the Escape-prefixed form used by legacy terminals. A
legacy terminal cannot distinguish Alt from Meta, so `alt+n` and `meta+n` may
overlap there; Kitty keyboard events keep them distinct.

Inline saved notes also expose clickable **Edit**, **Reply**, and (for reply-free user notes)
**Delete** actions. `E` edits the first editable user note in the selected hunk and `R` replies
to its first visible stored note. Replies inherit the code anchor and may be nested without a
product depth limit. Static sidecar annotations are not reply targets, and a parent cannot be
deleted until its replies are removed.

The built-in commands and the keys they ship with:

On a terminal, `hunk log` opens its read-only history browser automatically. Its controls are
separate from the configurable review command table. `F10` opens File, View, Navigate, Commit, and Help menus;
View includes Hunk's shared theme selector and an optional **Graph view** that replaces the default
day-grouped timeline with commit-topology lanes. It uses `Up`/`Down` or `j`/`k` to move, `PageUp`/`PageDown`,
`g`/`G` or `Home`/`End` to jump, `/` to search, `n`/`N` for matches, `t` to choose a theme, `r` to refresh, `y` to copy
the full commit id, `Enter` to open the commit in normal Hunk review, and `q` to quit. With a mouse, click a commit
id to open it immediately, click the adjacent copy icon to copy its full immutable id, click elsewhere
on a row to select it, or double-click a row to open it.
Quitting the opened review returns to the retained history selection and viewport. The Commit menu's
**Compare with first parent** and **Compare with parent…** actions compare the selected commit against
an ordered provider-owned parent; they do not navigate the history selection to that parent.

In plain working-tree reviews, **Space** stages the selected file's remaining unstaged changes,
or unstages it when fully staged. Folder rows in the files pane are selectable too: Space
and the clickable action beside the stream tabs apply to the files shown under that folder — nested files
in the wide tree projection, or only the files listed under that header in the compact grouped projection.
Clicking a wide-tree folder selects it and collapses or expands it; double-clicking never stages a folder.
If any of those files still have unstaged changes, Space stages them; otherwise it unstages the fully staged ones.
File-row double-click and the clickable action beside the stream tabs do the same for a selected file.
The sidebar shows Git-style status columns: green index changes and red worktree changes,
including partially staged files. Untracked files show red `??`; staged additions show green `A`
and a green filename. The selected file or folder has a full-row highlight. A successful file action follows the file to the other tab.
Clicking a code line or navigating with `[` / `]` selects **hunk** action scope: Space then stages
that unstaged hunk, or unstages that staged hunk, without changing other hunks or disk contents.
Double-clicking a code line applies its hunk on release, provided the pointer did not move. Hunk actions keep the current stream tab;
use Tab to review the other side. Clicking a sidebar file or file header, or using `,` / `.` returns to file scope.
The action beside the tabs names the current scope. Drag-to-copy remains available; hunks without an available staging action and non-working-tree
reviews retain word/line selection on repeated clicks. Binary, text-converted, and metadata-only changes use file actions.
**e** opens `$EDITOR` at a deliberately clicked, stepped-to, or revealed source line. Otherwise it
uses the active hunk's first changed line, not its leading context. From the staged view, Git maps
that index line through further unstaged insertions, replacements, and deletions to the current
working-tree location. Missing files, stale source state, and text-converted lines produce
a notice instead of a guessed location. Supported line-jump syntax covers vi/vim/nvim,
code/code-insiders/cursor, and hx; unknown editor syntax is refused instead of opening at file start.
**d** opens discard choices for the selected file or folder: Enter or **x** discards all its changes,
**u** discards only unstaged changes when both sides have changes, and Escape cancels.
**s** opens a selected-file or selected-folder stash message input; Enter stashes and Escape cancels. The stash
contains only those files' changes, including each staged/unstaged split, not unrelated staged files.
These actions require a selected actionable file or folder in the visible, focused file panel. They reject stale targets and
renames whose former path has been recreated. Stashing requires an initial commit. While reviewing a hunk,
with the file panel hidden, or outside an actionable working-tree review, **d** retains half-page scrolling and **s** toggles the files pane;
**Ctrl+d** and the View menu remain available in working-tree reviews.
**Tab** switches the complete Unstaged/Staged review stream; selecting a sidebar file that only
has changes on the other side switches automatically. Selecting a folder stays on the current
side when any file under it belongs there. The files pane keeps +/- counts on every status row,
including files that only have changes on the other tab. Use `/` to focus the filter.
Actions wait for Git and its refreshed diff before accepting another mutation. Outside this
context, Space still pages and Tab retains its files/filter focus behavior. All these commands
remain remappable, and an explicit user binding takes precedence over contextual defaults.

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
| `hunk.review.discardSelectedFile`              | Discard selected file or folder changes        | `d`                          |
| `hunk.review.editActiveNote`                   | Edit the active review note                    | `E`                          |
| `hunk.review.editSelectedFile`                 | Open the selected file in your editor          | `e`                          |
| `hunk.review.focusDiffPane`                    | Focus the selected file's review               | `enter`                      |
| `hunk.review.focusFilesPane`                   | Focus the files pane                           | `escape`                     |
| `hunk.review.focusFilter`                      | Focus the file filter                          | `/`                          |
| `hunk.review.halfPageDown`                     | Scroll down half a page                        | `d`, `ctrl+d`                |
| `hunk.review.halfPageUp`                       | Scroll up half a page                          | `u`, `ctrl+u`                |
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
| `hunk.review.replyToActiveNote`                | Reply to the active review note                | `R`                          |
| `hunk.review.scrollCodeLeft`                   | Scroll code left (shifted scrolls fast)        | `left`, `shift+left`         |
| `hunk.review.scrollCodeRight`                  | Scroll code right (shifted scrolls fast)       | `right`, `shift+right`       |
| `hunk.review.startNote`                        | Add a review note                              | `c`                          |
| `hunk.review.stashSelectedFile`                | Stash selected file or folder                  | `s`                          |
| `hunk.review.stepDown`                         | Move down in the focused pane                  | `down`, `j`                  |
| `hunk.review.stepUp`                           | Move up in the focused pane                    | `up`, `k`                    |
| `hunk.review.toggleFileStaged`                 | Stage / unstage selected file or folder        | `space`                      |
| `hunk.review.toggleHunkGap`                    | Expand or collapse the selected context        | `z`                          |
| `hunk.review.toggleHunkStaged`                 | Stage / unstage selected hunk                  | `space`                      |
| `hunk.review.toggleStagedView`                 | Switch unstaged / staged stream                | `tab`                        |
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
command keeps its menu item and simply stops showing a key. When two enabled
commands share a chord, only the first-match owner advertises it; remaining
aliases stay visible (`f` still pages, `Ctrl+d` still half-pages, `/` still
focuses the filter).

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
