# Inline edit extension

A miniature line editor for the file under review. Press `Ctrl-E`, type into the diff, press `Ctrl-S`, and Hunk writes the file back to your working tree after asking you first.

This example is **not bundled or loaded by Hunk**. Install it explicitly if you want it.

It exists to demonstrate that Hunk's interactive extension surfaces compose, so it uses them all at once:

| Capability                              | Where this extension uses it                                                                                                                                                                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.workspace`                         | `canWriteDocument` gates the affordance, `readDocument("new")` fills the buffer, `writeDocument` performs the consented write and reloads the review.                                                                                                                  |
| `mode` on a registered file view        | `onKey` claims arrows, editable characters, Backspace, Enter, and `Ctrl-S`, while `]`, `?`, and `q` pass through so navigation, help, and quit keep working. `Ctrl-S` is recognized with `matchesKey`, so the bare control byte terminals send for it matches too.     |
| `fileViews.enterMode(viewId)`           | One call makes the view the file's presentation _and_ gives its mode the keyboard, so `Ctrl-E` opens the editor in a single press.                                                                                                                                     |
| `fileViews.refresh(viewId, { fileId })` | Every buffer or caret change re-derives the layout. A view's layout is a pure function of `(file, width)`, so this is the only way a stateful presentation redraws — and the buffer belongs to one file, so the refresh is scoped to it and no other file re-lays out. |

## Try it from this checkout

```bash
bun run packages/hunk/src/main.tsx -- diff --extension ./examples/extensions/inline-edit
```

## Install it globally

Copy the whole folder — it has no dependencies:

```bash
mkdir -p ~/.config/hunk/extensions
cp -R examples/extensions/inline-edit ~/.config/hunk/extensions/
```

Hunk discovers the folder automatically on later launches. Open **View** and choose **File presentation: Inline edit**, or press `Ctrl-E`. The command is named `inline-edit.edit` for `[keybindings]` customization.

## Keys

| Key                           | Does                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `Ctrl-E`                      | Starts editing the selected file, showing the view if it was not already.     |
| `↑` `↓` `←` `→`               | Move the caret. `←`/`→` wrap across line ends.                                |
| any other printable character | Types at the caret — including characters bound to Hunk commands, like `z`.   |
| `Backspace`                   | Deletes back one character, joining with the previous line at column 0.       |
| `Enter`                       | Splits the line at the caret.                                                 |
| `Ctrl-S`                      | Asks Hunk to write the buffer. Hunk confirms, writes, and reloads the review. |
| `Esc`                         | Leaves the editor and **discards** everything typed since the last write.     |
| everything else               | Still Hunk's: `]` moves to the next hunk, `?` opens help, `q` quits.          |

The header row reads `EDITING — Esc exits · ctrl+s writes`, plus a `MODIFIED` marker whenever the buffer differs from the text on disk.

## How the pieces fit

`Ctrl-E` is one press. The command gates on `canWriteDocument`, starts reading the document, and calls `fileViews.enterMode` before awaiting that read. Entry therefore uses the same selected file the command captured; a selection change cannot attach a late buffer to another file. `enterMode` makes the view that file's presentation and gives its mode the keyboard together, then the completed read builds the buffer and refreshes the view. When entry refuses (no `mode`, a file Hunk keeps on raw diff, a view that does not match), it warns by name and returns `false` without installing a buffer.

The editor slot is claimed synchronously, before that command's first `await`. Reading the document suspends the handler, so a guard that only checked "is a session live?" would let a second `Ctrl-E` through the window in between, and one of the two handlers would then be parked forever on a session nothing could end. The claim is released on every way out — an unwritable review, an unreadable document, a refused `enterMode` — and once a session is live it is the live session that answers the next press.

`onKey` has to answer synchronously — its return value _is_ the routing decision — and the mode context carries only `file` and `fileViews`. So a keystroke can never write anything itself. What `Ctrl-S` does instead is post a request into the edit session, and the command handler that entered the mode is still awaiting that session: `ctx.workspace` is valid for the whole life of a command handler's promise, so the handler is the mode's async runtime.

That loop ends the same way from every direction, because `onExit` runs on every exit path:

- **Saved.** A successful `writeDocument` reloads the session, the reload exits the mode, `onExit` ends the loop.
- **Escaped.** Escape is host-owned, so it exits the mode without ever reaching `onKey`, and the loop ends the same way.
- **Cancelled write.** `{ ok: false, reason: "cancelled" }` is the user answering, not a failure. The editor keeps running.
- **Failed write.** The `detail` sentence is shown as a warning and the editor keeps running, so nothing typed is lost to a full disk.

## Limitations

This is a demonstration, not an editor:

- **No wrapping.** Lines are truncated at the pane width with `…`. A file-view layout must be deterministic for `(file, width)`, and wrapping would be a second layout problem on top of the one this example is about.
- **Whole-line truncation.** The caret can move past the visible edge; the row does not scroll horizontally to follow it.
- **One buffer, no undo.** Escape discards everything since the last write, with no confirmation beyond the notice it leaves behind.
- **Writes are working-tree only**, which is a property of `ctx.workspace`: `hunk show`, `hunk patch`, a staged diff, and a file-pair diff have no working-tree document to replace, so the command refuses instead of opening an editor that could not save.
- **Agent notes describe the document as it was loaded.** They stay on the lines they were written about, but nothing re-reads the changeset while you type.

## Source bindings and provenance

Rows carry `sourceRanges` so Hunk can place its own inline notes inside this presentation, and a row may only bind a line it honestly still _is_. Row position cannot answer that once you split or join a line, so the edit session keeps **provenance**: for each buffer line, the document line it came from, or nothing at all.

| Edit               | Provenance                                                               |
| ------------------ | ------------------------------------------------------------------------ |
| typing in a line   | kept — an edited line is still the line it came from                     |
| `Enter` (split)    | the first line keeps it; the new tail gets none                          |
| `Backspace` (join) | the merged line presents both source lines so either note stays attached |

So a line you inserted binds nothing, the lines below a split keep the numbers they had, and a joined row keeps every source line it now presents. The hunk extents in `hunkRows` are derived from the same provenance, so the hunk highlight follows the rows still holding a hunk's lines instead of drifting down by however many lines you added above them. A join across two distinct hunks is refused because one bound row cannot belong to two hunk extents.

One thing this shows that is easy to get wrong: Hunk accepts a binding only on a row exactly one `hunkRows` extent owns, and rejects the whole layout otherwise — so a last pass drops the bindings no extent owns, and context lines outside every hunk are presented without one. The [rendered Markdown example](../rendered-markdown/) ends its layout with the same pass, for the same reason.

## Where this is documented

- [`docs/extensions.md` → Interactive file views](../../../docs/extensions.md#interactive-file-views)
- [`docs/extensions.md` → Reading and writing a reviewed file](../../../docs/extensions.md#reading-and-writing-a-reviewed-file)
- [`docs/extensions.md` → `hunk.registerFileView(view)`](../../../docs/extensions.md#hunkregisterfileviewview-experimental)
