# Comment cursor UI

## Problem

Hunk already stores per-line review comments through the `LiveComment` model and the session-broker protocol. Today only MCP-driven agents can author them — there is no way for a developer inside the TUI to drop a comment on a diff line so an agent can batch-fix the highlighted issues later.

This spec adds a keyboard-driven cursor that the user can move row-by-row through the diff stream, mark a single line, type a short note, and save it. Saved comments flow through the existing live-comment store so the agent picks them up via the same `hunk session comment list` / `review` commands it uses today.

## Scope

In scope:

- A cursor that highlights one diff row at a time.
- A mode toggle (`c`) that turns the cursor on and off.
- Keyboard navigation of the cursor within a hunk, across hunks, and across files.
- An inline composer mounted on the cursor row that lets the user type one short comment.
- A `source: "user"` flavour of `LiveComment` that reuses every existing storage, rendering, and broker code path.

Out of scope:

- Multi-line range selection. Comments stay single-line to match the current API surface of `LiveComment` and `hunk session comment add`.
- Editing or replying to an existing comment from the cursor. Removal continues to flow through `removeLiveComment` / `hunk session comment rm`.
- Persisting user comments to disk across sessions. Comments live in the in-memory store for the lifetime of the session, same as today's MCP comments.
- Mouse-driven cursor placement. Keyboard only for v1.

## User flow

1. User is reviewing a diff in `hunk diff` / `hunk show`.
2. User presses `c`. The cursor appears on the first content row of the currently selected hunk (first `+`, falling back to first `-`, then context — same anchor rule the existing `firstCommentTargetForHunk` uses for MCP comments).
3. User presses `j` / `k` (or `Up` / `Down`) to move row-by-row. `[` / `]` jump to the previous / next hunk's first row, mirroring existing hunk navigation. The viewport scrolls to keep the cursor in view.
4. User presses `i` (or `Return`) to open a composer on the cursor row. An OpenTUI `<input>` is focused.
5. User types a short note and presses `Return` to save. The comment is stored as a `LiveComment` with `source: "user"` and renders as a note card directly under the line, exactly like an agent comment.
6. User presses `Esc` (or `c` again) to leave cursor mode. The cursor highlight disappears; saved comments remain visible.

A View-menu entry mirrors the `c` shortcut so the action is discoverable in the menu bar.

## Architecture

The feature is a thin layer on top of three systems that already exist:

- The shared review state in `useReviewController`, which owns selection, the live-comment map, and navigation actions.
- The planned-row rendering pipeline in `src/ui/diff/reviewRenderPlan.ts`, which the diff stream uses to insert non-diff rows (inline notes, guide caps, separators).
- The mode-aware keyboard router in `useAppKeyboardShortcuts`, which already gates input through pager / help / menu / filter handlers.

No parallel state, no overlay layer, no new package. The cursor lives next to `selectedFileId` and `selectedHunkIndex`, the composer mounts as a new planned-row kind, and the keyboard handler grows one more mode handler.

```text
useReviewController
  ├── selectedFileId / selectedHunkIndex   (existing)
  ├── liveCommentsByFileId                 (existing — gains user-authored entries)
  └── commentCursor                        (new)
        ├── mode: "off" | "navigating" | "composing"
        ├── fileId, hunkIndex, side, line
        └── actions: setCursorMode, moveCursor, openComposer, saveComment, cancelComposer

reviewRenderPlan
  └── planned row kinds                    (gains "comment-composer" alongside existing "inline-note")

useAppKeyboardShortcuts
  └── handleCursorShortcut                 (new mode handler between menu and filter)

core/liveComments.ts
  └── buildUserLiveComment                 (new helper next to buildLiveComment)
```

## State model

New state in `useReviewController`:

```ts
type CursorMode = "off" | "navigating" | "composing";

interface CommentCursor {
  mode: CursorMode;
  fileId: string;
  hunkIndex: number;
  side: "old" | "new";
  line: number;
}
```

- `mode: "off"` — cursor not rendered. Default for users who never invoke the feature.
- `mode: "navigating"` — cursor highlight is visible on a row, keyboard navigates it.
- `mode: "composing"` — cursor row also has the composer mounted, keyboard input goes to the composer's `<input>`.

The cursor never maintains its own scroll position. When the cursor moves to a row outside the current viewport, the controller reuses `selectHunk(fileId, hunkIndex)` to reveal the owning hunk, then leans on the existing `scrollChildIntoView` path on OpenTUI's scrollbox for sub-hunk row reveal. This keeps the diff pane's scrolling under one source of truth.

## Cursor geometry

A new pure helper module, `src/ui/lib/commentCursor.ts`, owns the geometry math. It mirrors the shape of the existing `src/ui/lib/hunks.ts` helpers (a cursor list plus a `moveCursor` walker) so contributors find the same pattern in both places.

Exports:

- `firstCursorTargetForHunk(file, hunkIndex): { side, line }` — returns the first content row of a hunk (first `+`, falling back to first `-`, then context). Delegates to the existing `firstCommentTargetForHunk` in `core/liveComments.ts` so the cursor and an MCP comment land on the same anchor when invoked on the same hunk.
- `moveCursor(cursor, files, delta): CommentCursor | null` — walks forward / backward through the diff rows of the review stream. Skips file headers, hunk headers, and inter-file separators. Crosses hunk boundaries within a file and file boundaries across the stream the same way `findNextHunkCursor` already does.
- `cursorRowStableKey(cursor): string` — returns the file-scoped stable key (`line:<hunkIndex>:<side>:<line>`) that `reviewRenderPlan` already emits, so the row renderer can look up the cursor row and apply highlight.

The helper has no React or OpenTUI dependencies. Tests live alongside it as `src/ui/lib/commentCursor.test.ts`.

## Rendering

Two render-side changes, both inside the existing single-pipeline pattern:

1. `src/ui/diff/reviewRenderPlan.ts` gains a new planned row kind:

   ```ts
   | {
       kind: "comment-composer";
       key: string;
       stableKey: string;
       fileId: string;
       hunkIndex: number;
       side: "old" | "new";
       line: number;
     }
   ```

   The row is emitted directly after the cursor row when `cursor.mode === "composing"`. Same insertion shape as the existing `inline-note` row.

2. `src/ui/lib/diffSectionGeometry.ts` and the row renderer in `src/ui/diff/renderRows.tsx` learn how to measure and render the composer row. The composer height is a constant (three lines: top border, input row, bottom border), matching the inline-note geometry approach.

A new component `src/ui/components/panes/CommentComposer.tsx` provides the visual. It follows the visual language of `AgentInlineNote` so user comments and agent comments feel like siblings:

- Same `theme.noteBorder` / `theme.noteBackground` colours.
- Title row: `Comment · <path>:<side><line>   Enter save · Esc cancel`.
- Body row: an OpenTUI `<input>` set to `focused={true}`, full inner width.

The cursor highlight itself is applied by the existing row renderer when it sees a row whose stable key matches `cursorRowStableKey(cursor)`. One small render hook, no overlay.

## Keyboard model

A new mode handler `handleCursorShortcut(key)` is added to `useAppKeyboardShortcuts.ts`, slotted between `handleMenuShortcut` and `handleFilterShortcut` so menus and the filter input still take precedence.

| Mode | Key | Action |
|---|---|---|
| off | `c` | enter `navigating` on the first row of the selected hunk |
| navigating | `up` / `k` | move cursor up one row |
| navigating | `down` / `j` | move cursor down one row |
| navigating | `[` / `]` | jump to the previous / next hunk's first row |
| navigating | `i` or `return` | promote to `composing` |
| navigating | `c` or `esc` | return to `off` |
| composing | `return` | save the comment, return to `navigating` on the same row |
| composing | `esc` | discard, return to `navigating` |
| composing | any other key | owned by the focused `<input>` |

Default scrolling behaviour for users who never press `c` is unaffected: `up` / `down` still scroll one row, `[` / `]` still navigate hunks. The cursor handler only intercepts when `cursor.mode !== "off"`.

A View-menu entry `Toggle comment cursor (c)` is added through `buildAppMenus` so the action is discoverable next to the existing toggles.

## Live-comment plumbing

User comments flow through the same store as MCP comments, with one new builder and one widened type.

- `src/core/liveComments.ts` gains `buildUserLiveComment(target, body, commentId, createdAt, hunkIndex)`. The body shape is identical to the existing `buildLiveComment`. The new helper sets `source: "user"`, `tags: ["user"]`, omits `confidence`, and emits `[line, line]` for whichever side the cursor is on.
- `src/hunk-session/types.ts` widens `LiveComment.source` from `"mcp"` to `"mcp" | "user"`. `SessionLiveCommentSummary` is unchanged — it does not expose `source` — so the broker wire format and `hunk session comment list` output are byte-for-byte unchanged.
- `useReviewController` gains `addUserLiveComment(target, body)`. It calls the new builder and pushes the result into `liveCommentsByFileId` using the same setter the MCP path uses. `removeLiveComment` and `clearLiveComments` already key on id and file path, not source, so removal works for user comments without change.

Comment id format: `user:<timestamp>-<counter>`, mirroring the existing `mcp:<requestId>:<index>` convention. No new packages required.

Once stored, user comments render through the existing `AgentInlineNote` path because they live in the same `liveCommentsByFileId` map. The card title already includes range information, so a `source: "user"` comment will show up as a note card under the line with no additional render work.

## Testing

Tests are colocated with the code they cover, following the repo convention.

- `src/ui/lib/commentCursor.test.ts` — pure-function coverage of `firstCursorTargetForHunk` and `moveCursor`. Cases: within-hunk movement, cross-hunk movement, cross-file movement, clamping at the start and end of the review stream, behaviour on empty hunks, behaviour on hunks with only context rows.
- `src/core/liveComments.test.ts` — extend with `buildUserLiveComment` cases. Cases: `source: "user"`, `[line, line]` range on the correct side, `tags: ["user"]`, no `confidence`.
- `src/ui/AppHost.interactions.test.tsx` — extend with the full interaction flow at the AppHost level. Cases: `c` enters cursor mode, `j` / `k` moves, `i` opens the composer, `Return` saves and the comment appears in `liveCommentSummaries`, `Esc` from the composer cancels without saving, `c` exits cursor mode.
- `test/pty/comment-cursor-integration.test.ts` — one new PTY-backed integration test covering the real terminal flow: launch with a sample diff, press `c`, navigate, type a comment, press `Return`, assert the rendered note card appears under the line. PTY coverage is required by the repo's verification rules for interaction and layout changes.

## Verification

Per the repo's verification rules, before reporting the work complete:

- `bun run typecheck`
- `bun test`
- `bun run test:integration`
- `bun run test:tty-smoke`
- One real TTY smoke run on a sample diff to confirm the cursor highlight, composer card, and saved comment look right.

## Risks and tradeoffs

- **Two roles for `up` / `down`.** When the cursor is off, `up` / `down` scroll. When the cursor is on, they move the cursor. This is consistent with the existing mode-router pattern (the filter input already changes the meaning of typing keys when focused), and it is gated on a visible cursor highlight, so the meaning of the key is always discoverable from screen state.
- **Composer height changes geometry.** Mounting the composer adds three rows to the diff stream, which the geometry layer has to measure. The existing `inline-note` path already handles dynamically-sized rows, so we extend the same code rather than introducing a new measurement system.
- **Comment id collisions.** A timestamp + counter format is sufficient for a single session; the broker already namespaces by session id. If we ever batch-import user comments from disk we will need a stronger id, but that is out of scope here.

## Non-goals revisited

This spec deliberately keeps the user comment shape identical to the MCP comment shape. Any future expansion — ranges, threading, replies, persistence — is a separate spec built on top of the same store. Keeping v1 single-line and in-memory keeps the surface area small and lets the existing `hunk session comment *` CLI surface user comments with zero changes.
