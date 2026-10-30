/**
 * Inline edit — a miniature line editor for the file under review.
 *
 * This is the demonstration three extension-API capabilities were built for,
 * and the proof that they compose:
 *
 * - `ctx.workspace` fills the buffer with `readDocument`, gates the affordance
 *   with `canWriteDocument`, and performs the consented `writeDocument`.
 * - a file view `mode` routes real keystrokes into the view: it claims arrows,
 *   most printable characters, Backspace, Enter, and Ctrl-S, and declines
 *   `]`, `?`, and `q` so navigation, help, and quit keep working. One
 *   `enterMode` selects the view *and* takes the keyboard, so one Ctrl-E opens
 *   the editor rather than two.
 * - `fileViews.refresh(VIEW_ID, { fileId })` re-derives the layout after every
 *   buffer or caret change, which is the only way a stateful view redraws at
 *   all — scoped to the edited file, because the buffer is that file's state
 *   and every other file presenting this view is still showing its document.
 *
 * Keys are matched with `matchesKey` from the public API rather than by reading
 * modifier flags, so Ctrl-S is recognized in both forms terminals send it:
 * `ctrl: true, name: "s"`, and the bare C0 control byte `0x13`, which
 * carries no `ctrl` flag at all.
 *
 * The load-bearing shape is the command handler. `onKey` must answer
 * synchronously, and the mode context deliberately carries only `file` and
 * `fileViews` — so a keystroke can only *request* a save. `ctx.workspace` is
 * valid for the whole life of a command handler's promise, so the handler that
 * entered the mode parks on a session lifecycle loop and is the thing that
 * actually writes. Every exit path — the reload after a save, Escape, a
 * host auto-exit — runs `onExit`, which ends that loop, so the handler always
 * settles and no promise is left dangling.
 *
 * That last guarantee is why the editor slot is claimed *synchronously*, before
 * the handler's first `await`: two fast Ctrl-E presses would otherwise both
 * pass a guard that only reads the live session, and the loser's loop would
 * park on a mailbox nothing is left holding a reference to.
 */

import { matchesKey } from "hunkdiff/extension";
import type {
  ExtensionCommandContext,
  ExtensionDiffFile,
  ExtensionFactory,
  ExtensionFileChangeRange,
  ExtensionFileViewRow,
  ExtensionFileViewSpan,
  ExtensionKeyEvent,
} from "hunkdiff/extension";

/** The registered view id. This folder's extension id is `inline-edit` too. */
const VIEW_ID = "inline-edit";
const HEADER_LABEL = "EDITING — Esc exits · ctrl+s writes";
const MODIFIED_MARKER = "  MODIFIED";
/** Marks the cursor line in the gutter, where an editor would show a caret. */
const CURSOR_MARK = "▎";

/** What the mode can ask its command handler for, between keystrokes. */
type SessionRequest = "save" | "end";

/**
 * One file's live edit buffer, plus the mailbox the mode talks to the command
 * handler through.
 *
 * The mailbox is the whole trick: `requestSave` and `end` are synchronous, so
 * `onKey` and `onExit` can call them and answer immediately, while `next()` is
 * what the async handler awaits.
 */
interface EditSession {
  readonly fileId: string;
  readonly path: string;
  /** The line terminator the document was read with, preserved on write. */
  readonly newline: string;
  /** Whether the document ended with a terminator, also preserved on write. */
  readonly endsWithNewline: boolean;
  /** Mutated in place — never reassigned, since `text()` closes over it. */
  readonly lines: string[];
  /** New-side ranges used to keep one merged row owned by at most one hunk. */
  readonly hunkRanges: readonly (readonly [number, number])[];
  /**
   * The **provenance policy**: for each buffer line, the one-based line of the
   * document lines it was loaded from that this line still presents, or an
   * empty array for a line the document never had.
   *
   * Row positions stop describing the document the moment a line is split or
   * joined, so this array — not the row's index — is what a source binding may
   * claim. It is kept parallel to `lines` by exactly three rules:
   *
   * - typing in a line keeps its provenance; an edited line still corresponds
   *   to the line it came from;
   * - a split keeps the first line's provenance and gives the tail none,
   *   because the tail is a line the document does not have;
   * - a join combines both lines' provenance, so notes bound to either source
   *   line remain attached to the merged row.
   */
  readonly provenance: number[][];
  /** The text on disk as far as this session knows, so `MODIFIED` is a fact. */
  savedText: string;
  cursorLine: number;
  cursorColumn: number;
  /** Ask the command handler to write the buffer. Answers immediately. */
  requestSave(): void;
  /** Tell the handler the session is over. Every exit path calls this. */
  end(): void;
  /** Await the next request. Resolves `"end"` forever once the session ended. */
  next(): Promise<SessionRequest>;
  /** The buffer as one document, with the read's line endings restored. */
  text(): string;
}

/** Clamp a value into an inclusive range. */
function clamp(value: number, low: number, high: number) {
  return Math.min(Math.max(value, low), high);
}

/** Segment text by user-perceived characters so editing never splits UTF-16 pairs. */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Return every grapheme in a string without splitting emoji or combining sequences. */
function graphemes(value: string) {
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

/** Return the previous valid caret boundary in one line. */
function previousGraphemeBoundary(value: string, column: number) {
  let previous = 0;
  for (const { index } of graphemeSegmenter.segment(value)) {
    if (index >= column) {
      break;
    }
    previous = index;
  }
  return previous;
}

/** Snap an arbitrary column backward onto a valid caret boundary. */
function snapGraphemeBoundary(value: string, column: number) {
  if (column >= value.length) {
    return value.length;
  }
  let boundary = 0;
  for (const { index } of graphemeSegmenter.segment(value)) {
    if (index > column) {
      break;
    }
    boundary = index;
  }
  return boundary;
}

/** Return the next valid caret boundary in one line. */
function nextGraphemeBoundary(value: string, column: number) {
  for (const { index, segment } of graphemeSegmenter.segment(value)) {
    if (index >= column) {
      return index + segment.length;
    }
  }
  return value.length;
}

/** Return the zero-based grapheme column at one valid string boundary. */
function graphemeColumn(value: string, boundary: number) {
  let column = 0;
  for (const { index } of graphemeSegmenter.segment(value)) {
    if (index >= boundary) {
      break;
    }
    column += 1;
  }
  return column;
}

/** Return the string boundary at one zero-based grapheme column. */
function boundaryAtGraphemeColumn(value: string, column: number) {
  let current = 0;
  for (const { index } of graphemeSegmenter.segment(value)) {
    if (current === column) {
      return index;
    }
    current += 1;
  }
  return value.length;
}

/** Cut text to a terminal-cell budget without splitting a grapheme. */
function truncate(value: string, width: number) {
  if (Bun.stringWidth(value) <= width) {
    return value;
  }
  if (width <= 0) {
    return "";
  }
  const budget = width - Bun.stringWidth("…");
  let used = 0;
  let visible = "";
  for (const segment of graphemes(value)) {
    const segmentWidth = Bun.stringWidth(segment);
    if (used + segmentWidth > budget) {
      break;
    }
    visible += segment;
    used += segmentWidth;
  }
  return `${visible}…`;
}

/** Split a document into editable lines, dropping the terminator's empty tail. */
function splitDocumentLines(text: string) {
  // CRLF, LF, and bare CR all count: a CR-only document is still a document
  // with lines, and treating it as one line would edit the wrong structure.
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines.length > 0 ? lines : [""];
}

/** The document's own line terminator, preserved verbatim on write. */
function detectNewline(text: string) {
  if (text.includes("\r\n")) {
    return "\r\n";
  }
  return text.includes("\r") ? "\r" : "\n";
}

/** Collect the new-side line numbers this changeset added, for read-only tone. */
function addedLineNumbers(changes: readonly ExtensionFileChangeRange[]) {
  const added = new Set<number>();
  for (const change of changes) {
    if (change.kind !== "added") {
      continue;
    }
    for (let line = change.range[0]; line <= change.range[1]; line += 1) {
      added.add(line);
    }
  }
  return added;
}

/**
 * The character a key would type, or `null` for anything that is not text.
 *
 * A mode receives every key the app's modal surfaces did not claim, so deciding
 * what counts as typing is the extension's job: one character, no modifier that
 * turns it into a chord, and nothing in the C0/DEL control range (which is how
 * Enter, Tab, Backspace, and Ctrl-S arrive).
 */
function printableCharacter(key: ExtensionKeyEvent) {
  if (key.ctrl === true || key.meta === true || key.option === true) {
    return null;
  }
  const sequence = key.sequence ?? "";
  if (graphemes(sequence).length !== 1) {
    return null;
  }
  const code = sequence.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f ? sequence : null;
}

/** Build one file's edit session from the exact document text behind it. */
function createEditSession(file: ExtensionDiffFile, text: string, cursorLine: number): EditSession {
  const newline = detectNewline(text);
  const endsWithNewline = /\r\n$|\r$|\n$/.test(text);
  const lines = splitDocumentLines(text);

  let pending: ((request: SessionRequest) => void) | null = null;
  let queued: SessionRequest | null = null;
  let ended = false;

  /** Hand one request to the waiting handler, or hold it until one waits. */
  const post = (request: SessionRequest) => {
    if (ended) {
      return;
    }
    if (request === "end") {
      ended = true;
    }
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve(request);
      return;
    }
    // `"end"` supersedes a held save: once the session is over, the write that
    // save asked for no longer belongs to anything.
    queued = request === "end" ? "end" : (queued ?? "save");
  };

  const session: EditSession = {
    fileId: file.id,
    path: file.path,
    newline,
    endsWithNewline,
    lines,
    hunkRanges: (file.hunks ?? []).map((hunk) => hunk.newRange ?? [1, 1]),
    // Loading the document is the one moment buffer and document agree, so
    // every line starts out being exactly the line it was read from.
    provenance: lines.map((_, index) => [index + 1]),
    // Normalized rather than the raw read, so a document with mixed terminators
    // is not reported as modified before anyone has typed into it.
    savedText: lines.join(newline) + (endsWithNewline ? newline : ""),
    cursorLine: clamp(cursorLine, 0, lines.length - 1),
    cursorColumn: 0,
    requestSave: () => post("save"),
    end: () => post("end"),
    next() {
      if (queued !== null) {
        const request = queued;
        queued = null;
        return Promise.resolve(request);
      }
      // An ended session answers instantly, so a handler can never park on a
      // promise nothing is left to resolve.
      if (ended) {
        return Promise.resolve<SessionRequest>("end");
      }
      return new Promise<SessionRequest>((resolve) => {
        pending = resolve;
      });
    },
    text: () => lines.join(newline) + (endsWithNewline ? newline : ""),
  };
  return session;
}

/** Keep the caret inside the buffer after any edit or movement. */
function clampCursor(session: EditSession) {
  session.cursorLine = clamp(session.cursorLine, 0, session.lines.length - 1);
  const line = session.lines[session.cursorLine] ?? "";
  session.cursorColumn = snapGraphemeBoundary(line, clamp(session.cursorColumn, 0, line.length));
}

/**
 * Insert typed text at the caret.
 *
 * Provenance is untouched: an edited line is still the document line it came
 * from, so a note bound to it stays where the user is typing.
 */
function insertText(session: EditSession, text: string) {
  const line = session.lines[session.cursorLine] ?? "";
  session.lines[session.cursorLine] =
    line.slice(0, session.cursorColumn) + text + line.slice(session.cursorColumn);
  session.cursorColumn += text.length;
  clampCursor(session);
}

/** Delete backwards, joining with the previous line at column 0. */
function deleteBackwards(session: EditSession) {
  const line = session.lines[session.cursorLine] ?? "";
  if (session.cursorColumn > 0) {
    const previousColumn = previousGraphemeBoundary(line, session.cursorColumn);
    session.lines[session.cursorLine] =
      line.slice(0, previousColumn) + line.slice(session.cursorColumn);
    session.cursorColumn = previousColumn;
    clampCursor(session);
    return;
  }
  if (session.cursorLine === 0) {
    return;
  }
  const mergedSources = [
    ...session.provenance[session.cursorLine - 1]!,
    ...session.provenance[session.cursorLine]!,
  ];
  const sourceHunkOwners = new Set(
    mergedSources.flatMap((source) =>
      session.hunkRanges.flatMap((range, hunkIndex) =>
        source >= range[0] && source <= range[1] ? [hunkIndex] : [],
      ),
    ),
  );
  // One row cannot belong to two hunk extents under the host layout contract.
  // Refuse only that boundary join instead of dropping bindings and hiding the editor.
  if (sourceHunkOwners.size > 1) {
    return;
  }
  const previous = session.lines[session.cursorLine - 1] ?? "";
  session.lines.splice(session.cursorLine - 1, 2, previous + line);
  // A merged row presents both source lines, so notes bound to either line stay
  // visible instead of forcing the host back to raw diff around a hidden mode.
  session.provenance.splice(session.cursorLine - 1, 2, mergedSources);
  session.cursorLine -= 1;
  session.cursorColumn = previous.length;
  clampCursor(session);
}

/** Split the current line at the caret. */
function splitLine(session: EditSession) {
  const line = session.lines[session.cursorLine] ?? "";
  session.lines.splice(
    session.cursorLine,
    1,
    line.slice(0, session.cursorColumn),
    line.slice(session.cursorColumn),
  );
  // Provenance policy: the head is still the line it was, and the tail is a
  // line the document has never had — so it gets no provenance rather than
  // inheriting the number of whatever line used to sit below it.
  session.provenance.splice(session.cursorLine, 1, session.provenance[session.cursorLine]!, []);
  session.cursorLine += 1;
  session.cursorColumn = 0;
  clampCursor(session);
}

/** Move the caret one line or one column, wrapping columns across line ends. */
function moveCursor(session: EditSession, key: ExtensionKeyEvent) {
  if (key.name === "up" || key.name === "down") {
    const line = session.lines[session.cursorLine] ?? "";
    const column = graphemeColumn(line, session.cursorColumn);
    session.cursorLine = clamp(
      session.cursorLine + (key.name === "down" ? 1 : -1),
      0,
      session.lines.length - 1,
    );
    session.cursorColumn = boundaryAtGraphemeColumn(
      session.lines[session.cursorLine] ?? "",
      column,
    );
    return;
  }
  if (key.name === "left") {
    if (session.cursorColumn === 0 && session.cursorLine > 0) {
      session.cursorLine -= 1;
      session.cursorColumn = (session.lines[session.cursorLine] ?? "").length;
    } else {
      const line = session.lines[session.cursorLine] ?? "";
      session.cursorColumn = previousGraphemeBoundary(line, session.cursorColumn);
    }
    clampCursor(session);
    return;
  }
  const line = session.lines[session.cursorLine] ?? "";
  if (session.cursorColumn >= line.length && session.cursorLine < session.lines.length - 1) {
    session.cursorLine += 1;
    session.cursorColumn = 0;
  } else {
    session.cursorColumn = nextGraphemeBoundary(line, session.cursorColumn);
  }
  clampCursor(session);
}

/** Render the editing header, which is also where `MODIFIED` is reported. */
function headerRow(session: EditSession, width: number): ExtensionFileViewRow {
  const marker = session.text() === session.savedText ? "" : MODIFIED_MARKER;
  // The marker outranks the key legend when columns are tight: unsaved work is
  // the more important half of this row.
  const label = truncate(HEADER_LABEL, Math.max(0, width - marker.length));
  const spans: ExtensionFileViewSpan[] = [];
  if (label.length > 0) {
    spans.push({ text: label, tone: "accent", attributes: ["bold"] });
  }
  if (marker.length > 0) {
    spans.push({ text: truncate(marker, width), tone: "added", attributes: ["bold"] });
  }
  // Every row has to occupy a terminal cell, however narrow the pane got.
  return { id: "editing", spans: spans.length > 0 ? spans : [{ text: " " }] };
}

/**
 * A whole-file inline editor for the reviewed document.
 *
 * Every piece of mutable state lives in this closure, keyed to the file it
 * belongs to, so nothing leaks between files or between Hunk sessions.
 */
const inlineEditExtension: ExtensionFactory = (hunk) => {
  // At most one session exists at a time — the host allows one active mode
  // app-wide — but it is tagged with its file so a layout for any *other* file
  // presenting this view still renders read-only.
  let editSession: EditSession | null = null;
  const sessionFor = (fileId: string) => (editSession?.fileId === fileId ? editSession : null);

  /**
   * Whether a command handler is between claiming the editor and having a live
   * session. `editSession` alone cannot answer that: it is assigned after the
   * `readDocument` await, and a guard that only reads it lets a second press
   * through the window in between.
   */
  let opening = false;
  let openingFileId: string | null = null;

  /**
   * Claim the one editor slot, then build the session `file` is edited through
   * — or `null` when the review, the document, or the host refuses.
   *
   * The claim is taken synchronously, before the first await, and released on
   * every way out of this function, so exactly one command handler can ever own
   * the mailbox a session's keystrokes are posted to.
   */
  const beginEditSession = async (ctx: ExtensionCommandContext, file: ExtensionDiffFile) => {
    opening = true;
    openingFileId = file.id;
    try {
      // The affordance gate. Reads work in every review kind, but writes are
      // working-tree only, and an editor that cannot save is a lie.
      if (!ctx.workspace.canWriteDocument(file.id)) {
        ctx.notify(
          `${file.path} cannot be written from this review — inline edit needs a working-tree diff`,
          "warning",
        );
        return null;
      }

      // Start the read, but enter before awaiting it. Nothing can change the
      // live selection between these synchronous operations, so the mode and
      // the command's file are guaranteed to agree.
      const documentPromise = ctx.workspace.readDocument(file.id, "new");
      const viewWasActive = ctx.fileViews.isActive(VIEW_ID);
      if (!ctx.fileViews.enterMode(VIEW_ID)) {
        return null;
      }

      const document = await documentPromise;
      // Selection changes and Escape auto-exit the mode while the read is in
      // flight. Never install the late buffer after its keyboard disappeared.
      if (!ctx.fileViews.isModeActive(VIEW_ID)) {
        ctx.notify(`Editor closed while ${file.path} was loading`, "warning");
        return null;
      }
      if (document === null) {
        ctx.notify(`No readable document for ${file.path}`, "warning");
        ctx.fileViews.exitMode();
        // Entry selected this view before the read failed. Restore raw unless
        // this presentation was already selected when the command began.
        if (!viewWasActive) {
          ctx.fileViews.select(null);
        }
        return null;
      }

      // Start on the hunk the user was looking at, so editing opens where the
      // review already pointed.
      const hunks = file.hunks ?? [];
      const selectedHunk = hunks[ctx.selection.hunkIndex ?? 0] ?? hunks[0];
      const session = createEditSession(file, document, (selectedHunk?.newRange?.[0] ?? 1) - 1);
      editSession = session;
      ctx.fileViews.refresh(VIEW_ID, { fileId: file.id });
      return session;
    } finally {
      // Held across the opening window only. A live session is guarded by
      // `editSession` from here on, and a refused one left it null.
      opening = false;
      openingFileId = null;
    }
  };

  hunk.registerFileView({
    id: VIEW_ID,
    title: "Inline edit",
    matches(file) {
      // Any file Hunk read as text. A deleted file matches too and is declined
      // by `layout` below, where the missing new side actually shows up.
      return file.isBinary !== true && file.isTooLarge !== true;
    },
    async layout(input) {
      const session = sessionFor(input.file.id);
      // While a session is live the buffer *is* the document: re-reading would
      // throw away everything typed since the last write.
      const document = session ? null : await input.readDocument("new");
      if (!session && document === null) {
        return null;
      }
      if (input.signal.aborted) {
        return null;
      }

      const lines = session ? session.lines : splitDocumentLines(document ?? "");
      const numberWidth = String(Math.max(lines.length, 1)).length;
      // The caret cell is reserved in both states, so entering the mode changes
      // what the rows say without reflowing where the text starts.
      const gutterWidth = numberWidth + 2;
      const textWidth = Math.max(1, input.width - gutterWidth);
      // Added-line tone belongs to the read-only presentation only: once the
      // buffer is edited, the changeset's line numbers no longer describe it.
      const added = session ? new Set<number>() : addedLineNumbers(input.changes);
      const headerOffset = session ? 1 : 0;
      // The single source of truth for everything this layout claims about the
      // document: which document line each buffer line still is. Before a
      // session exists the buffer *is* the document, so the mapping is the
      // identity; while one runs it is the session's provenance, which survives
      // splits and joins that row positions do not.
      const provenance: number[][] = session
        ? session.provenance
        : lines.map((_, index) => [index + 1]);
      // The new-side line spans this file's changeset declares, which both the
      // hunk extents and the bindings that must sit inside them come from.
      const hunkRanges: [number, number][] = (input.file.hunks ?? []).map(
        (entry) => entry.newRange ?? [1, 1],
      );

      const rows: ExtensionFileViewRow[] = [];
      if (session) {
        rows.push(headerRow(session, input.width));
      }

      lines.forEach((line, index) => {
        const lineNumber = index + 1;
        const onCursor = session !== null && index === session.cursorLine;
        const visible = truncate(line, textWidth);
        const spans: ExtensionFileViewSpan[] = [
          {
            text: `${onCursor ? CURSOR_MARK : " "}${String(lineNumber).padStart(numberWidth)} `,
            tone: onCursor ? "accent" : "muted",
          },
        ];

        if (session && onCursor) {
          // Three spans put the caret on a column without needing an inverse
          // attribute the row contract does not have.
          const caret = snapGraphemeBoundary(
            visible,
            clamp(session.cursorColumn, 0, visible.length),
          );
          const caretEnd = nextGraphemeBoundary(visible, caret);
          if (caret > 0) {
            spans.push({ text: visible.slice(0, caret) });
          }
          spans.push({
            text: visible.slice(caret, caretEnd) || " ",
            tone: "accent",
            attributes: ["underline", "bold"],
          });
          if (caretEnd < visible.length) {
            spans.push({ text: visible.slice(caretEnd) });
          }
        } else if (added.has(lineNumber)) {
          spans.push({ text: visible, tone: "added" });
        } else {
          spans.push({ text: visible });
        }

        const sources = provenance[index] ?? [];
        rows.push({
          id: `line:${lineNumber}`,
          spans,
          // One row may present several source lines after a join. Preserve all
          // of them so notes never disappear behind a still-active edit mode.
          ...(sources.length === 0
            ? {}
            : {
                sourceRanges: sources.map((source) => ({
                  side: "new" as const,
                  range: [source, source] as const,
                })),
              }),
        });
      });

      // Hunk extents come from the same provenance, for the same reason: the
      // hunk highlight has to follow the rows still holding the hunk's lines,
      // wherever splitting and joining above them moved those rows to.
      const hunkRows = hunkRanges.map((range) => {
        let startRow = -1;
        let endRow = -1;
        provenance.forEach((sources, index) => {
          if (!sources.some((line) => line >= range[0] && line <= range[1])) {
            return;
          }
          const row = headerOffset + index;
          startRow = startRow === -1 ? row : startRow;
          endRow = row;
        });
        // A malformed or source-less hunk may have no represented row left.
        // Collapse it onto the first row: in bounds, which is all the host asks
        // of an extent, and the pass below keeps it from claiming a binding.
        return startRow === -1 ? { startRow: 0, endRow: 0 } : { startRow, endRow };
      });

      // Hunk places an inline note through a bound row, and only accepts one
      // that exactly one hunk extent owns. Context lines outside every hunk —
      // and the whole file when a review has no hunks at all — are presented
      // without a binding rather than making the layout unusable.
      const boundRows = rows.map((row, rowIndex) => {
        const owners = hunkRows.filter(
          (extent) => rowIndex >= extent.startRow && rowIndex <= extent.endRow,
        ).length;
        if (owners === 1 || row.sourceRanges === undefined) {
          return row;
        }
        const { sourceRanges: _unowned, ...unbound } = row;
        return unbound;
      });

      return { rows: boundRows, hunkRows };
    },
    mode: {
      onEnter(ctx) {
        // The command enters synchronously before awaiting its document read,
        // so the live mode file must be the file that claimed the opening slot.
        if (openingFileId !== ctx.file.id) {
          ctx.notify("Inline edit mode must be opened with Ctrl-E", "warning");
          ctx.fileViews.exitMode();
        }
      },
      onKey(key, ctx) {
        const session = sessionFor(ctx.file.id);
        if (!session) {
          // No buffer means nothing here is an editor; decline rather than
          // swallow keys the review still has uses for.
          return "pass";
        }

        // Requested, never performed: `onKey` answers synchronously, and the
        // write lives on the command handler's promise with `ctx.workspace`.
        if (matchesKey("ctrl+s", key)) {
          session.requestSave();
          return "handled";
        }

        // These printable keys remain host-owned by the example's explicit
        // policy: hunk navigation, help, and quit must stay reachable.
        if (key.sequence === "]" || key.sequence === "?" || key.sequence === "q") {
          return "pass";
        }

        if (
          key.name === "up" ||
          key.name === "down" ||
          key.name === "left" ||
          key.name === "right"
        ) {
          moveCursor(session, key);
        } else if (key.name === "backspace") {
          deleteBackwards(session);
        } else if (matchesKey("enter", key)) {
          splitLine(session);
        } else {
          const character = printableCharacter(key);
          if (character === null) {
            // Everything the editor has no use for stays Hunk's: `]` still
            // moves to the next hunk and `?` still opens the help overlay.
            return "pass";
          }
          insertText(session, character);
        }

        // A stateful view has no `(file, width)` change to announce, so this is
        // how every keystroke reaches the screen — for this file's buffer only.
        ctx.fileViews.refresh(VIEW_ID, { fileId: session.fileId });
        return "handled";
      },
      onExit(ctx) {
        const ending = editSession;
        editSession = null;
        // The only thing that ends the command handler's loop. Escape, a
        // reload after a write, and a host auto-exit all arrive here.
        ending?.end();
        // Back to the read-only presentation, again for the edited file alone.
        ctx.fileViews.refresh(VIEW_ID, { fileId: ending?.fileId ?? ctx.file.id });
      },
    },
  });

  hunk.registerCommand(
    { id: "edit", title: "Edit the selected file inline", key: "ctrl+e" },
    async (ctx) => {
      const file = ctx.selection.file;
      if (!file) {
        ctx.notify("Select a file to edit", "warning");
        return;
      }

      // `onKey` passes on Ctrl-E, so this command is reachable from inside its
      // own mode, and from a second press while the first one is still opening.
      // Answer both instead of starting a second session on one file.
      if (opening) {
        ctx.notify("Already opening the editor");
        return;
      }
      if (editSession !== null) {
        ctx.notify(`Already editing ${editSession.path} — Esc exits, ctrl+s writes`);
        return;
      }

      const session = await beginEditSession(ctx, file);
      if (!session) {
        return;
      }

      // From here this handler *is* the mode's runtime. It stays parked on the
      // session's mailbox until something ends the session, which is why the
      // write can be async while `onKey` stays synchronous.
      for (let request = await session.next(); request !== "end"; request = await session.next()) {
        const text = session.text();
        if (text === session.savedText) {
          ctx.notify("No unsaved edits");
          continue;
        }

        const result = await ctx.workspace.writeDocument({ fileId: session.fileId, text });
        if (result.ok) {
          session.savedText = text;
          ctx.notify(`Wrote ${session.path}`);
          // Hunk reloads the review after a successful write, and a reload
          // exits the mode — `onExit` posts the `"end"` this loop stops on.
          continue;
        }
        if (result.reason === "cancelled") {
          // The user answered the question. Keep editing.
          continue;
        }
        ctx.notify(result.detail, "warning");
      }

      if (session.text() !== session.savedText) {
        ctx.notify(`Discarded unsaved edits to ${session.path}`);
      }
    },
  );
};

export default inlineEditExtension;
