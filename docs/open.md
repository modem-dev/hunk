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
- `e`: edit a private copy of the displayed regular file in `$EDITOR`, using the visible line as
  the editor target; save back when the editor exits.
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
directory browsing works without Git. An interrupted or failed ignore query makes that directory
unavailable rather than treating partial ignore output as complete. Hidden and
ignored entries are initially excluded, but an explicitly named hidden file still opens normally.

Symlinks are listed but not followed, including explicitly opened links and symlinked descendants.
Devices and other non-regular entries are not opened. Binary/non-UTF-8 files, files over 1 MiB,
and missing or unreadable entries show a placeholder. Each directory is limited to 10,000 entries
and at most 128 directories may be expanded. Source reads remain bounded when a file grows while
it is being read. Terminal control sequences are stripped before painting.

On Linux, directory enumeration uses the checked directory's retained handle. Other platforms
recheck ancestry and directory identity before publishing entries, but portable Node APIs do not
provide handle-relative directory enumeration. Browsing is not a sandbox against a hostile process
that can repeatedly replace and restore ancestors; use it on trusted local directories.

Editors receive a private temporary copy, not a checked collection path. Hunk retains the original
file handle and checks that the file identity and content still match before writeback. Detected
replacement or modification cancels writeback and retains the edited copy at the path shown in the
notice. Editor errors also retain that copy. Known GUI editors receive `--wait`; custom editor
wrappers must wait until editing finishes. Each document browser permits one active editor action;
repeated editor actions in that browser are rejected while it is active. Quitting waits for the editor transaction to settle, and late
failures/recovery paths are printed after the terminal is restored. `$EDITOR` itself is trusted
code, not sandboxed.

Updated Hunk sessions in the same OS account and process namespace coordinate validation and writeback with
private, inode-keyed save claims under the OS account home's `.hunk/document-save-claims/` directory.
This location is independent of per-session `HOME`, XDG and temporary-directory overrides. Account
lookup uses OS records, including built-in PowerShell without profiles on Windows; lookup or private
directory failures refuse writeback and retain the edited copy. Competing
saves are rejected with their editor copies retained; claims left by definitely dead processes are
removed. An unrelated process reusing an owner's PID can conservatively delay saving until it exits.
Save claims do not coordinate different hosts/accounts or container process namespaces, older Hunk
versions, or non-Hunk writers.
Those writers can still race the final conflict check, and in-place writeback is not crash-atomic.

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

Stdin, multiple path arguments, and `file:line` addressing are deferred. The browser writes only
when saving a private copy from an explicitly launched external editor; it does not reopen the
collection path for writeback.
