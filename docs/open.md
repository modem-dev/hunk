# Complete-document browsing

`hunk open [path]` views a file or browses a directory. The default path is `.`. It requires an
interactive terminal, but not a repository or a diff.

```bash
hunk open README.md
hunk open ~/project
hunk open hypr/ --theme nord
hunk open file.ts --wrap --tab-width 4
```

## Controls

- Arrow keys or `j`/`k`: move through the focused tree or document.
- Enter/Space: open a file or expand/collapse a directory.
- Left/Right: collapse/expand the selected directory, or scroll the focused document horizontally.
- Tab: switch tree/document focus. `s`: toggle the tree.
- PageUp/PageDown, `g`/`G`, Home/End: scroll the focused surface.
- `i`: toggle hidden and Git-ignored entries together. Hidden entries are names starting with `.`.
- `e`: open the displayed regular file in `$EDITOR`, using the visible line as the editor target.
- `t`, `l`, `w`, `?`, `r`, `q`: themes, line numbers, wrapping, help, refresh, quit.
- File/View/Help menus provide the same actions with mouse support. F10 opens the menu by keyboard.

Common app/view commands keep their existing command ids. Document actions use `hunk.documents.*`:
`activate`, `edit`, `stepDown`, `stepUp`, `pageDown`, `pageUp`, `jumpToTop`, `jumpToBottom`,
`scrollLeft`, `scrollRight`, and `toggleExcluded`. User `[keybindings]` remaps apply to menus and help.

```toml
[open]
theme = "nord"
wrap_lines = true

[keybindings]
"hunk.documents.stepDown" = "ctrl+n"
"hunk.documents.stepUp" = "ctrl+p"
```

## Filesystem policy

Only immediate children of expanded directories are read. The document viewer mounts a bounded
row window and reads only the selected document. Refresh preserves the displayed document and
scroll position; selecting a directory does not replace the document already displayed.

In a Git worktree, Git supplies ignore rules and lightweight status markers. Metadata queries are
optional, bounded, and asynchronous; repository fsmonitor hooks and clean/process filters are
disabled. Status queries do not recurse into submodules or fetch missing objects. Ordinary
directory browsing works without Git. Hidden and
ignored entries are initially excluded, but an explicitly named hidden file still opens normally.

Symlinks are listed but not followed, including explicitly opened links and symlinked descendants.
Devices and other non-regular entries are not opened. Binary/non-UTF-8 files, files over 1 MiB,
and missing or unreadable entries show a placeholder. Each directory is limited to 10,000 entries
and at most 128 directories may be expanded. Source reads remain bounded when a file grows while
it is being read. Terminal control sequences are stripped before painting.

Expanded directories and the displayed file's parent are observed for changes, covering atomic
file replacements and deletions. Watch notifications are debounced; manual and watch refreshes
serialize. A failed watcher can be worked around with `r`. Shutdown cancels pending source work,
releases observers, and waits for started reads to settle before tearing down the terminal.

## Architecture and current boundaries

`core/documents` defines opaque entry identities, complete text and availability results, and lazy
source capabilities. Filesystem operations and Git metadata live in `app/documents`; the browser
controller and geometry live in `ui/documents`. The existing session host routes this surface
alongside history and review, reusing terminal lifecycle, theme ownership, menu components,
keymaps, editor launching, syntax paint, and exact native text measurement.

Browsing never constructs `DiffFile`, hunks, or `ReviewDocument`, and it does not publish a review
session to the broker. User extensions remain review-specific and are not loaded by `open`.
The source contract is currently internal; a future public document extension API should expose
explicit capabilities without weakening review navigation or workspace-write policies.

Stdin, multiple path arguments, and `file:line` addressing are deferred. The browser never writes
files itself; edits happen only in the explicitly launched external editor.
