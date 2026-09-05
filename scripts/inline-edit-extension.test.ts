import { describe, expect, test } from "bun:test";
import type {
  ExtensionCommand,
  ExtensionCommandHandler,
  ExtensionFileChangeRange,
  ExtensionDiffFile,
  ExtensionFileView,
  ExtensionFileViewLayout,
  ExtensionKeyEvent,
  ExtensionWorkspaceWriteResult,
  HunkExtensionAPI,
} from "../packages/hunk/src/extension-api/types";
import { validateFileViewLayout } from "../packages/hunk/src/ui/fileViews/layout";
import { buildFileViewRenderPlan } from "../packages/hunk/src/ui/fileViews/renderPlan";
import { createVisibleAgentNote } from "../packages/hunk/src/ui/lib/agentAnnotations";
import inlineEditExtension from "../examples/extensions/inline-edit";

const TEST_FILE = {
  id: "alpha",
  path: "alpha.ts",
  patch: "",
  stats: { additions: 1, deletions: 0 },
  metadata: {},
  agent: null,
  hunks: [{ index: 0, header: "@@ -1 +1,2 @@", newRange: [2, 2] }],
} as const;

/**
 * A three-line file whose one hunk covers the whole document.
 *
 * Editing in the middle of a buffer is what moves rows away from the lines they
 * were loaded from, and a hunk over every line is what lets the host's own
 * validator check the result: it requires each bound row to sit inside exactly
 * one hunk extent.
 */
const WHOLE_FILE_HUNK_FILE = {
  ...TEST_FILE,
  hunks: [{ index: 0, header: "@@ -1,3 +1,3 @@", newRange: [1, 3] }],
} as const;

const THREE_LINE_DOCUMENT = "alpha\nbeta\ngamma\n";

const ADDED_SECOND_LINE: ExtensionFileChangeRange[] = [
  { hunkIndex: 0, kind: "added", range: [2, 2] },
];

/**
 * Ctrl-S as a terminal that decodes nothing sends it: a bare C0 byte, with no
 * `ctrl` flag and no `name`. Spelled by code point so it stays visible here.
 */
const CTRL_S_CONTROL_BYTE = String.fromCharCode(0x13);

/** Register the example against a fake API and keep what it contributed. */
function registerInlineEditTestExtension() {
  let view: ExtensionFileView | undefined;
  let command: ExtensionCommand | undefined;
  let commandHandler: ExtensionCommandHandler | undefined;
  inlineEditExtension({
    registerCommand(candidate: ExtensionCommand, handler: ExtensionCommandHandler) {
      command = candidate;
      commandHandler = handler;
    },
    registerFileView(candidate: ExtensionFileView) {
      view = candidate;
    },
  } as HunkExtensionAPI);
  return { view: view!, command: command!, commandHandler: commandHandler! };
}

/** Let every already-resolved promise in the handler's loop run to its next await. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Report whether a command handler's promise settles, on a deadline.
 *
 * A handler that parks on a mailbox nothing can end never rejects — it simply
 * never resolves — so awaiting it directly would hang the run instead of
 * failing it.
 */
function settlement(handler: void | Promise<void>) {
  return Promise.race([
    Promise.resolve(handler).then(() => "settled" as const),
    new Promise<"parked">((resolve) => setTimeout(() => resolve("parked"), 50)),
  ]);
}

/** Flatten one layout row to the text a terminal would show. */
function rowText(layout: ExtensionFileViewLayout | null, index: number) {
  return (layout?.rows[index]?.spans ?? []).map((span) => span.text).join("");
}

/**
 * Drive the example the way the host does.
 *
 * The fake owns the thing the real host owns and the extension only observes:
 * the mode lifecycle callbacks that fire around `enterMode`/`exitMode`. There
 * is no separate "is the view showing" state to set up, because `enterMode`
 * selects the view for the file itself.
 */
function createInlineEditTestHost({
  canWrite = true,
  document = "alpha\nbeta\n",
  enters = true,
  file = TEST_FILE as unknown as ExtensionDiffFile,
  holdDocumentReads = false,
  write = async (): Promise<ExtensionWorkspaceWriteResult> => ({ ok: true }),
}: {
  canWrite?: boolean;
  document?: string | null;
  /** Whether the fake host lets `enterMode` start the mode, as the real one may refuse. */
  enters?: boolean;
  /** The reviewed file the command acts on, when the default hunk shape is not the point. */
  file?: ExtensionDiffFile;
  /** Suspend `readDocument` until the test releases it, to open the command's await window. */
  holdDocumentReads?: boolean;
  write?: (text: string) => Promise<ExtensionWorkspaceWriteResult>;
} = {}) {
  const { view, command, commandHandler } = registerInlineEditTestExtension();
  const notices: { message: string; type?: string }[] = [];
  const refreshed: { viewId: string; fileId?: string }[] = [];
  const selected: (string | null)[] = [];
  const writes: string[] = [];
  const documentReads: string[] = [];
  let modeActive = false;
  let viewActive = false;
  let releaseDocumentReads = () => {};
  const readGate = holdDocumentReads
    ? new Promise<void>((resolve) => {
        releaseDocumentReads = resolve;
      })
    : null;

  const fileViews = {
    select: (viewId: string | null) => {
      selected.push(viewId);
      viewActive = viewId === "inline-edit";
    },
    refresh: (viewId: string, options?: { fileId?: string }) =>
      refreshed.push({
        viewId,
        ...(options?.fileId === undefined ? {} : { fileId: options.fileId }),
      }),
    isActive: () => viewActive,
    isModeActive: () => modeActive,
    // One step in the real host too: entering selects the view for the file
    // when it is not already showing it, so there is nothing to activate first.
    enterMode: () => {
      if (!enters) {
        return false;
      }
      modeActive = true;
      viewActive = true;
      view.mode?.onEnter?.({ ...modeContext(), file } as never);
      return true;
    },
    exitMode: () => {
      if (!modeActive) {
        return;
      }
      modeActive = false;
      view.mode?.onExit?.(modeContext() as never);
    },
  };
  const notify = (message: string, type?: string) => notices.push({ message, type });
  const modeContext = () => ({ cwd: "/repo", file, fileViews, notify });

  const ctx = {
    cwd: "/repo",
    notify,
    fileViews,
    selection: { file, hunkIndex: 0 },
    workspace: {
      canWriteDocument: () => canWrite,
      readDocument: async (fileId: string) => {
        // Suspending here is what a slow working-tree read does to the command:
        // it opens a window in which a second Ctrl-E can arrive.
        if (readGate) {
          await readGate;
        }
        documentReads.push(fileId);
        return document;
      },
      writeDocument: async ({ text }: { fileId: string; text: string }) => {
        writes.push(text);
        return write(text);
      },
    },
  };

  return {
    command,
    documentReads,
    notices,
    refreshed,
    selected,
    view,
    writes,
    isModeActive: () => modeActive,
    /** Let a held `readDocument` resolve, closing the window it opened. */
    releaseDocumentReads: () => releaseDocumentReads(),
    /** Run the command exactly as a keypress would, without awaiting its loop. */
    run: () => commandHandler(ctx as never),
    /** Deliver one key to the mode, answering `"pass"` when no mode is running. */
    press: (key: ExtensionKeyEvent) =>
      modeActive ? view.mode?.onKey(key, modeContext() as never) : "pass",
    /** Escape is host-owned: it exits without ever reaching `onKey`. */
    escape: () => fileViews.exitMode(),
    /** Lay the current file out at a fixed width, as the review stream does. */
    layout: (changes: ExtensionFileChangeRange[] = [], width = 40) =>
      view.layout({
        file,
        width,
        signal: new AbortController().signal,
        changes,
        readDocument: async () => {
          documentReads.push("view");
          return document;
        },
      } as never) as Promise<ExtensionFileViewLayout | null>,
  };
}

describe("inline edit example extension", () => {
  test("registers one interactive file view and one command on a free chord", () => {
    const host = createInlineEditTestHost();
    expect(host.command).toMatchObject({ id: "edit", key: "ctrl+e" });
    expect(host.view.id).toBe("inline-edit");
    expect(typeof host.view.mode?.onKey).toBe("function");
    expect(host.view.matches({ path: "alpha.ts" } as never)).toBe(true);
    expect(host.view.matches({ path: "logo.png", isBinary: true } as never)).toBe(false);
  });

  test("renders the read document with line numbers, added tone, and source bindings", async () => {
    const host = createInlineEditTestHost();
    const layout = await host.layout(ADDED_SECOND_LINE);

    expect(layout?.rows).toEqual([
      {
        id: "line:1",
        // Line 1 is context this file's one hunk does not cover, so it is shown
        // and not bound: Hunk requires every bound row to sit inside exactly one
        // hunk extent, and a note could never be placed here anyway.
        spans: [{ text: " 1 ", tone: "muted" }, { text: "alpha" }],
      },
      {
        id: "line:2",
        spans: [
          { text: " 2 ", tone: "muted" },
          { text: "beta", tone: "added" },
        ],
        sourceRanges: [{ side: "new", range: [2, 2] }],
      },
    ]);
    expect(layout?.hunkRows).toEqual([{ startRow: 1, endRow: 1 }]);
    expect(validateFileViewLayout(layout, TEST_FILE.hunks.length, 40)).toMatchObject({
      valid: true,
    });
  });

  test("declines the file when the new-side document is unreadable", async () => {
    const host = createInlineEditTestHost({ document: null });
    await expect(host.layout()).resolves.toBeNull();
  });

  test("enters the mode on one press, without a select of its own", async () => {
    const host = createInlineEditTestHost();

    void host.run();
    await flush();
    expect(host.isModeActive()).toBe(true);
    expect(host.documentReads).toEqual(["alpha"]);
    // `enterMode` selects the view as part of entering, so the command never
    // calls `select` and never asks for a second press.
    expect(host.selected).toEqual([]);
    expect(host.notices).toEqual([]);
    // `onEnter` asks for the redraw that swaps the read-only rows for the
    // buffer, scoped to the file whose buffer it is.
    expect(host.refreshed).toEqual([{ viewId: "inline-edit", fileId: "alpha" }]);
  });

  test("drops the buffer when the host refuses to enter the mode", async () => {
    const host = createInlineEditTestHost({ enters: false });

    await host.run();
    expect(host.isModeActive()).toBe(false);
    expect(host.documentReads).toEqual(["alpha"]);
    // `enterMode` warned by name already, so the command adds nothing — but the
    // buffer it built has to go, or the view would keep rendering an editor
    // with no keyboard behind it and a second press would refuse as busy.
    expect(host.notices).toEqual([]);
    expect(rowText(await host.layout(), 0)).toBe(" 1 alpha");
  });

  test("restores raw presentation when the opening document is unreadable", async () => {
    const host = createInlineEditTestHost({ document: null });

    await host.run();
    expect(host.isModeActive()).toBe(false);
    expect(host.selected).toEqual([null]);
    expect(host.notices.at(-1)).toMatchObject({
      message: "No readable document for alpha.ts",
      type: "warning",
    });
  });

  test("refuses to edit a review it could not write back to", async () => {
    const host = createInlineEditTestHost({ canWrite: false });

    await host.run();
    expect(host.isModeActive()).toBe(false);
    expect(host.documentReads).toEqual([]);
    expect(host.notices.at(-1)).toMatchObject({ type: "warning" });
    expect(host.notices.at(-1)?.message).toContain("working-tree diff");
  });

  test("renders the buffer, the caret, and the editing header while a session runs", async () => {
    const host = createInlineEditTestHost();
    void host.run();
    await flush();

    const layout = await host.layout(ADDED_SECOND_LINE);
    // The buffer is the document now, so nothing is re-read behind the editor.
    expect(host.documentReads).toEqual(["alpha"]);
    expect(rowText(layout, 0)).toBe("EDITING — Esc exits · ctrl+s writes");
    expect(rowText(layout, 1)).toBe(" 1 alpha");
    // The caret starts on the selected hunk's first new-side line.
    expect(layout?.rows[2]?.spans).toEqual([
      { text: "▎2 ", tone: "accent" },
      { text: "b", tone: "accent", attributes: ["underline", "bold"] },
      { text: "eta" },
    ]);
    // Added tone belongs to the read-only presentation; an edited buffer's line
    // numbers no longer describe the changeset.
    expect(layout?.rows.flatMap((row) => row.spans).some((span) => span.tone === "added")).toBe(
      false,
    );
    expect(layout?.hunkRows).toEqual([{ startRow: 2, endRow: 2 }]);
  });

  test("types, splits, joins, and moves the caret, refreshing on every change", async () => {
    const host = createInlineEditTestHost();
    void host.run();
    await flush();
    const refreshesBefore = host.refreshed.length;

    expect(host.press({ name: "z", sequence: "z" })).toBe("handled");
    expect(host.press({ name: "space", sequence: " " })).toBe("handled");
    expect(rowText(await host.layout(), 2)).toBe("▎2 z beta");

    expect(host.press({ name: "backspace", sequence: "" })).toBe("handled");
    expect(rowText(await host.layout(), 2)).toBe("▎2 zbeta");

    expect(host.press({ name: "return", sequence: "\r" })).toBe("handled");
    let layout = await host.layout();
    expect(rowText(layout, 2)).toBe(" 2 z");
    expect(rowText(layout, 3)).toBe("▎3 beta");

    // Backspace at column 0 joins the split back together.
    expect(host.press({ name: "backspace", sequence: "" })).toBe("handled");
    expect(rowText(await host.layout(), 2)).toBe("▎2 zbeta");

    expect(host.press({ name: "up" })).toBe("handled");
    expect(host.press({ name: "right" })).toBe("handled");
    layout = await host.layout();
    expect(rowText(layout, 1)).toBe("▎1 alpha");
    expect(layout?.rows[1]?.spans[2]).toEqual({
      text: "p",
      tone: "accent",
      attributes: ["underline", "bold"],
    });

    // Every buffer or caret change asked for its own redraw, and every one of
    // them named the edited file: the buffer is that file's state, so no other
    // file presenting this view has to lay out again.
    expect(host.refreshed.length - refreshesBefore).toBe(7);
    expect(host.refreshed).toEqual(
      host.refreshed.map(() => ({ viewId: "inline-edit", fileId: "alpha" })),
    );
    expect(rowText(await host.layout(), 0)).toContain("MODIFIED");
  });

  test("edits whole Unicode graphemes without corrupting surrogate pairs", async () => {
    const host = createInlineEditTestHost({ document: "😀\n" });
    const running = host.run();
    await flush();

    const initialLayout = await host.layout();
    expect(initialLayout?.rows[1]?.spans[1]).toMatchObject({ text: "😀", tone: "accent" });

    expect(host.press({ name: "right" })).toBe("handled");
    expect(host.press({ name: "backspace", sequence: "\u007f" })).toBe("handled");
    expect(host.press({ name: "s", ctrl: true })).toBe("handled");
    await flush();
    expect(host.writes).toEqual(["\n"]);

    expect(host.press({ name: "😀", sequence: "😀" })).toBe("handled");
    expect(host.press({ name: "s", ctrl: true })).toBe("handled");
    await flush();
    expect(host.writes).toEqual(["\n", "😀\n"]);

    host.escape();
    await running;
  });

  test("preserves the grapheme column during vertical Unicode movement", async () => {
    const twoLineFile = {
      ...TEST_FILE,
      hunks: [{ index: 0, header: "@@ -1,2 +1,2 @@", newRange: [1, 2] }],
    } as unknown as ExtensionDiffFile;
    const host = createInlineEditTestHost({ file: twoLineFile, document: "éx\nab\n" });
    const running = host.run();
    await flush();

    // One Right crosses the combining grapheme's two UTF-16 units. Down keeps
    // grapheme column 1, rather than mistaking that offset for column 2.
    expect(host.press({ name: "right" })).toBe("handled");
    expect(host.press({ name: "down" })).toBe("handled");
    const layout = await host.layout();
    expect(layout?.rows[2]?.spans.slice(1)).toEqual([
      { text: "a" },
      { text: "b", tone: "accent", attributes: ["underline", "bold"] },
    ]);

    host.escape();
    await running;
  });

  test("truncates wide graphemes by terminal cells without wrapping", async () => {
    const host = createInlineEditTestHost({ document: "界界\n" });
    const running = host.run();
    await flush();

    const layout = await host.layout([], 4);
    expect(rowText(layout, 1)).toBe("▎1 …");
    expect(validateFileViewLayout(layout, TEST_FILE.hunks.length, 4)).toMatchObject({
      valid: true,
    });

    host.escape();
    await running;
  });

  test("claims editable printable keys and preserves documented host shortcuts", async () => {
    const host = createInlineEditTestHost();
    void host.run();
    await flush();
    const refreshesBefore = host.refreshed.length;

    expect(host.press({ name: "z", sequence: "z" })).toBe("handled");
    expect(host.press({ name: "]", sequence: "]" })).toBe("pass");
    expect(host.press({ name: "?", sequence: "?", shift: true })).toBe("pass");
    expect(host.press({ name: "q", sequence: "q" })).toBe("pass");
    expect(host.press({ name: "tab", sequence: "\t" })).toBe("pass");
    expect(host.press({ name: "f8" })).toBe("pass");
    expect(host.press({ name: "g", sequence: "g", ctrl: true })).toBe("pass");
    expect(host.refreshed.length - refreshesBefore).toBe(1);
  });

  test("writes the buffer on ctrl+s, preserving the document's trailing newline", async () => {
    const host = createInlineEditTestHost();
    const running = host.run();
    await flush();

    // Nothing to write yet: the buffer still matches what was loaded.
    expect(host.press({ name: "s", ctrl: true })).toBe("handled");
    await flush();
    expect(host.writes).toEqual([]);
    expect(host.notices.at(-1)?.message).toBe("No unsaved edits");

    host.press({ name: "z", sequence: "z" });
    expect(host.press({ name: "s", ctrl: true })).toBe("handled");
    await flush();
    expect(host.writes).toEqual(["alpha\nzbeta\n"]);
    expect(host.notices.at(-1)?.message).toBe("Wrote alpha.ts");
    expect(rowText(await host.layout(), 0)).not.toContain("MODIFIED");

    // In the real host the write's reload exits the mode; here the exit stands
    // in for it, and either way `onExit` is what ends the handler's loop.
    host.escape();
    await running;
    expect(host.isModeActive()).toBe(false);
  });

  test("edits a CR-only document line by line and writes its own terminator back", async () => {
    // Bare-CR documents still exist in the wild; splitting only on \r?\n would
    // present this whole file as one line and rewrite it with LF on save.
    const host = createInlineEditTestHost({ document: "alpha\rbeta\r" });
    const running = host.run();
    await flush();

    const layout = await host.layout();
    expect(rowText(layout, 1)).toContain("alpha");
    expect(rowText(layout, 2)).toContain("beta");

    host.press({ name: "z", sequence: "z" });
    expect(host.press({ name: "s", ctrl: true })).toBe("handled");
    await flush();
    expect(host.writes).toEqual(["alpha\rzbeta\r"]);

    host.escape();
    await running;
  });

  test("recognizes ctrl+s as both a flagged chord and a bare control byte", async () => {
    const host = createInlineEditTestHost();
    const running = host.run();
    await flush();

    // The decoded form: the terminal reported the modifier and the letter.
    host.press({ name: "z", sequence: "z" });
    expect(host.press({ name: "s", ctrl: true })).toBe("handled");
    await flush();
    expect(host.writes).toEqual(["alpha\nzbeta\n"]);

    // The undecoded form, with no `ctrl` flag and no `name` to match on.
    // `matchesKey("ctrl+s", key)` is what makes it the same chord — an
    // extension reading `key.ctrl` itself would silently never save here.
    host.press({ name: "y", sequence: "y" });
    expect(host.press({ sequence: CTRL_S_CONTROL_BYTE })).toBe("handled");
    await flush();
    expect(host.writes).toEqual(["alpha\nzbeta\n", "alpha\nzybeta\n"]);
    // The byte is a chord, never text: nothing of it landed in the buffer.
    expect(rowText(await host.layout(), 2)).toBe("▎2 zybeta");

    host.escape();
    await running;
  });

  test("reports a failed write and keeps editing, and a cancelled one silently", async () => {
    const results: ExtensionWorkspaceWriteResult[] = [
      { ok: false, reason: "cancelled", detail: "The write to alpha.ts was declined." },
      { ok: false, reason: "failed", detail: "Failed to write alpha.ts • EACCES" },
    ];
    const host = createInlineEditTestHost({
      write: async () => results.shift() ?? { ok: true },
    });
    const running = host.run();
    await flush();
    host.press({ name: "z", sequence: "z" });

    host.press({ name: "s", ctrl: true });
    await flush();
    // A declined write is the user answering, not something to report.
    expect(host.notices).toEqual([]);
    expect(host.isModeActive()).toBe(true);

    host.press({ name: "s", ctrl: true });
    await flush();
    expect(host.notices.at(-1)).toMatchObject({
      message: "Failed to write alpha.ts • EACCES",
      type: "warning",
    });
    expect(host.isModeActive()).toBe(true);

    host.escape();
    await running;
  });

  test("claims the editor before its first await, so a second press strands nothing", async () => {
    const host = createInlineEditTestHost({ holdDocumentReads: true });

    // Both presses land while the first handler is suspended reading the
    // document — the window a guard that only reads the live session misses.
    const first = host.run();
    const second = host.run();

    // The loser answers immediately instead of building a second buffer and
    // parking forever on a mailbox nothing is left holding.
    expect(await settlement(second)).toBe("settled");
    expect(host.notices.at(-1)?.message).toBe("Already opening the editor");

    host.releaseDocumentReads();
    await flush();

    // Exactly one session became live: one read, one entry, one buffer.
    expect(host.documentReads).toEqual(["alpha"]);
    expect(host.isModeActive()).toBe(true);
    expect(host.refreshed).toEqual([{ viewId: "inline-edit", fileId: "alpha" }]);
    expect(host.press({ name: "z", sequence: "z" })).toBe("handled");
    expect(rowText(await host.layout(), 2)).toBe("▎2 zbeta");

    host.escape();
    expect(await settlement(first)).toBe("settled");
    expect(host.isModeActive()).toBe(false);
  });

  test("enters the selected file's mode before awaiting its document read", async () => {
    const host = createInlineEditTestHost({ holdDocumentReads: true });

    const running = host.run();
    // Entry is synchronous with the command's selection snapshot, so a later
    // selection change cannot attach this buffer to another file.
    expect(host.isModeActive()).toBe(true);
    expect(host.documentReads).toEqual([]);
    expect(host.refreshed).toEqual([]);

    host.releaseDocumentReads();
    await flush();
    expect(host.documentReads).toEqual(["alpha"]);
    expect(host.refreshed).toEqual([{ viewId: "inline-edit", fileId: "alpha" }]);

    host.escape();
    await running;
  });

  test("answers a second press while a session is live, leaving the buffer alone", async () => {
    const host = createInlineEditTestHost();
    const running = host.run();
    await flush();
    host.press({ name: "z", sequence: "z" });

    // Ctrl-E is one of the keys `onKey` passes on, so the command is reachable
    // from inside its own mode. The claim taken while opening must not have
    // replaced this answer.
    expect(await settlement(host.run())).toBe("settled");
    expect(host.notices.at(-1)?.message).toBe(
      "Already editing alpha.ts — Esc exits, ctrl+s writes",
    );
    expect(host.documentReads).toEqual(["alpha"]);
    expect(rowText(await host.layout(), 2)).toBe("▎2 zbeta");

    host.escape();
    expect(await settlement(running)).toBe("settled");
  });

  test("releases the editor claim on every failed entry", async () => {
    const unwritable = createInlineEditTestHost({ canWrite: false });
    await unwritable.run();
    await unwritable.run();
    expect(unwritable.notices).toHaveLength(2);

    const unreadable = createInlineEditTestHost({ document: null });
    await unreadable.run();
    await unreadable.run();
    expect(unreadable.documentReads).toEqual(["alpha", "alpha"]);

    // A refused `enterMode` drops the buffer, so the next press may try again.
    const refused = createInlineEditTestHost({ enters: false });
    await refused.run();
    await refused.run();
    expect(refused.documentReads).toEqual(["alpha", "alpha"]);
    expect(refused.notices).toEqual([]);
  });

  test("keeps rows bound to the lines they came from across a mid-buffer split", async () => {
    const host = createInlineEditTestHost({
      file: WHOLE_FILE_HUNK_FILE as unknown as ExtensionDiffFile,
      document: THREE_LINE_DOCUMENT,
    });
    const running = host.run();
    await flush();

    // Down then Left puts the caret at the end of line 1, so Enter inserts a
    // line in the middle of the document.
    expect(host.press({ name: "down" })).toBe("handled");
    expect(host.press({ name: "left" })).toBe("handled");
    expect(host.press({ name: "return", sequence: "\r" })).toBe("handled");

    const layout = await host.layout();
    expect(layout?.rows.map((_, index) => rowText(layout, index)).slice(1)).toEqual([
      " 1 alpha",
      "▎2  ",
      " 3 beta",
      " 4 gamma",
    ]);
    // Provenance, not row position: the inserted row is a line the document
    // never had, and every line below it still binds the line it came from.
    expect(layout?.rows.map((row) => row.sourceRanges ?? null)).toEqual([
      null,
      [{ side: "new", range: [1, 1] }],
      null,
      [{ side: "new", range: [2, 2] }],
      [{ side: "new", range: [3, 3] }],
    ]);
    // The hunk highlight follows the same provenance instead of drifting down
    // with the row positions the split moved.
    expect(layout?.hunkRows).toEqual([{ startRow: 1, endRow: 4 }]);
    expect(validateFileViewLayout(layout, WHOLE_FILE_HUNK_FILE.hunks.length, 40)).toMatchObject({
      valid: true,
    });

    host.escape();
    expect(await settlement(running)).toBe("settled");
  });

  test("keeps both source bindings through a join, and typing keeps them", async () => {
    const host = createInlineEditTestHost({
      file: WHOLE_FILE_HUNK_FILE as unknown as ExtensionDiffFile,
      document: THREE_LINE_DOCUMENT,
    });
    const running = host.run();
    await flush();

    // The caret opens on line 1 here, so Down then Backspace at column 0 joins
    // lines 1 and 2 into one.
    expect(host.press({ name: "down" })).toBe("handled");
    expect(host.press({ name: "backspace", sequence: "" })).toBe("handled");
    // Typing moves nothing: an edited line is still the line it came from.
    expect(host.press({ name: "z", sequence: "z" })).toBe("handled");

    const layout = await host.layout();
    expect(rowText(layout, 1)).toBe("▎1 alphazbeta");
    expect(layout?.rows.map((row) => row.sourceRanges ?? null)).toEqual([
      null,
      // The merged row presents both original lines, while `gamma` still binds
      // line 3 rather than sliding onto the removed row position.
      [
        { side: "new", range: [1, 1] },
        { side: "new", range: [2, 2] },
      ],
      [{ side: "new", range: [3, 3] }],
    ]);
    expect(layout?.hunkRows).toEqual([{ startRow: 1, endRow: 2 }]);
    expect(validateFileViewLayout(layout, WHOLE_FILE_HUNK_FILE.hunks.length, 40)).toMatchObject({
      valid: true,
    });
    expect(
      buildFileViewRenderPlan(layout!, [
        createVisibleAgentNote([], {
          id: "line-two",
          annotation: { id: "line-two", summary: "Line two", newRange: [2, 2] },
        }),
      ]).unresolvedNoteIds,
    ).toEqual([]);

    host.escape();
    expect(await settlement(running)).toBe("settled");
  });

  test("keeps a single-line hunk bound when its line joins the row above", async () => {
    const host = createInlineEditTestHost({ document: THREE_LINE_DOCUMENT });
    const running = host.run();
    await flush();

    // This file's one hunk covers new line 2 alone, and the caret opens there.
    expect(host.press({ name: "backspace", sequence: "" })).toBe("handled");

    const layout = await host.layout();
    expect(rowText(layout, 1)).toBe("▎1 alphabeta");
    // The merged row still presents line 2, so notes on that hunk keep an exact
    // anchor and the editor never falls back to a hidden raw-diff state.
    expect(layout?.rows[1]?.sourceRanges).toEqual([
      { side: "new", range: [1, 1] },
      { side: "new", range: [2, 2] },
    ]);
    expect(layout?.hunkRows).toEqual([{ startRow: 1, endRow: 1 }]);
    expect(validateFileViewLayout(layout, TEST_FILE.hunks.length, 40)).toMatchObject({
      valid: true,
    });

    host.escape();
    expect(await settlement(running)).toBe("settled");
  });

  test("escape discards the buffer, clears the session, and settles the handler", async () => {
    const host = createInlineEditTestHost();
    const running = host.run();
    await flush();
    host.press({ name: "z", sequence: "z" });

    host.escape();
    await running;

    expect(host.writes).toEqual([]);
    expect(host.notices.at(-1)?.message).toBe("Discarded unsaved edits to alpha.ts");
    // The session is gone: the view is back to rendering the document it reads.
    expect(rowText(await host.layout(), 0)).toBe(" 1 alpha");
    expect(host.press({ name: "z", sequence: "z" })).toBe("pass");
  });
});
