import { describe, expect, spyOn, test } from "bun:test";
import { SourceTextTooLargeError } from "../../core/changeset/fileSource";
import type { DiffFile } from "../../core/changeset/model";
import {
  createTestDeferred,
  createTestDiffFile,
  createTestSourceFetcher,
  lines,
} from "../../../../../test/helpers/diff-helpers";
import { ReviewSessionHost, type RevealLineFn } from "./reviewSessionHost";

const FIXED_NOW = 1_700_000_000_000;

/** Build twelve numbered lines with one changed line, so the file has one hunk and two gaps. */
function createTestNumberedFile(
  options: {
    id?: string;
    path?: string;
    changedValue?: number;
    sourceFetcher?: DiffFile["sourceFetcher"];
    agent?: DiffFile["agent"];
  } = {},
) {
  const before = Array.from(
    { length: 12 },
    (_unused, index) => `export const value${index + 1} = ${index + 1};`,
  );
  const after = [...before];
  after[7] = `export const value8 = ${options.changedValue ?? 800};`;
  return createTestDiffFile({
    after: lines(...after),
    agent: options.agent ?? null,
    before: lines(...before),
    context: 3,
    id: options.id ?? "alpha",
    path: options.path ?? "alpha.ts",
    sourceFetcher: options.sourceFetcher,
  });
}

/** Build one file with two hunks far enough apart to stay separate. */
function createTestTwoHunkFile(id = "beta", path = "beta.ts") {
  const before = Array.from(
    { length: 20 },
    (_unused, index) => `export const line${index + 1} = ${index + 1};`,
  );
  const after = [...before];
  after[0] = "export const line1 = 100;";
  after[19] = "export const line20 = 2000;";
  return createTestDiffFile({
    after: lines(...after),
    before: lines(...before),
    context: 3,
    id,
    path,
  });
}

/** Create a host over the given files with a fixed clock. */
function createTestHost(files: DiffFile[], options: { stmlEnabled?: boolean } = {}) {
  return new ReviewSessionHost({
    files,
    sourceLabel: "test",
    now: () => FIXED_NOW,
    ...options,
  });
}

/** Let settled fetcher promises deliver their status dispatches. */
async function flushTestMicrotasks() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

describe("ReviewSessionHost live comments", () => {
  test("adds, summarizes, removes, and clears live comments without a renderer", () => {
    const host = createTestHost([createTestNumberedFile(), createTestTwoHunkFile()]);

    const applied = host.addLiveComment(
      { filePath: "beta.ts", hunkIndex: 1, summary: "Second hunk", author: "agent" },
      "mcp:1",
      { reveal: true },
    );
    expect(applied).toMatchObject({ commentId: "mcp:1", fileId: "beta", hunkIndex: 1 });
    expect(host.getSelection()).toEqual({ fileId: "beta", hunkIndex: 1 });

    host.addLiveComment({ filePath: "alpha.ts", side: "new", line: 8, summary: "Line" }, "mcp:2");
    expect(host.getLiveCommentSummaries()).toEqual([
      {
        commentId: "mcp:2",
        filePath: "alpha.ts",
        hunkIndex: 0,
        side: "new",
        line: 8,
        summary: "Line",
        rationale: undefined,
        author: undefined,
        createdAt: new Date(FIXED_NOW).toISOString(),
      },
      expect.objectContaining({ commentId: "mcp:1", filePath: "beta.ts", hunkIndex: 1 }),
    ]);
    expect(host.getReviewNoteSummaries().map((note) => [note.noteId, note.source])).toEqual([
      ["mcp:2", "agent"],
      ["mcp:1", "agent"],
    ]);

    expect(host.removeLiveComment("mcp:2")).toEqual({
      commentId: "mcp:2",
      removed: true,
      remainingCommentCount: 1,
      source: "agent",
    });
    expect(() => host.removeLiveComment("mcp:2")).toThrow("No live comment matches id mcp:2.");

    expect(host.clearLiveComments("beta.ts")).toMatchObject({
      removedCount: 1,
      remainingCommentCount: 0,
      filePath: "beta.ts",
    });
    expect(() => host.clearLiveComments("missing.ts")).toThrow("missing.ts");
  });

  test("validates a whole batch before applying any of it", () => {
    const host = createTestHost([createTestNumberedFile()]);

    expect(() =>
      host.addLiveCommentBatch(
        [
          { filePath: "alpha.ts", hunkIndex: 0, summary: "ok" },
          { filePath: "alpha.ts", hunkIndex: 4, summary: "bad hunk" },
        ],
        "batch",
      ),
    ).toThrow();
    expect(host.getSnapshot().liveNotes).toEqual([]);

    const result = host.addLiveCommentBatch(
      [
        { filePath: "alpha.ts", hunkIndex: 0, summary: "first" },
        { filePath: "alpha.ts", hunkIndex: 0, summary: "second" },
      ],
      "batch",
      { revealMode: "first" },
    );
    expect(result.applied.map((entry) => entry.commentId)).toEqual(["mcp:batch:0", "mcp:batch:1"]);
    expect(host.getSnapshot().liveNotes).toHaveLength(2);
  });

  test("refuses markup unless STML is enabled, and reports the caller's measurement", () => {
    const disabled = createTestHost([createTestNumberedFile()]);
    expect(() =>
      disabled.addLiveComment(
        { filePath: "alpha.ts", hunkIndex: 0, summary: "s", markup: "<b>x</b>" },
        "mcp:1",
      ),
    ).toThrow("STML markup is disabled");
    expect(disabled.getSnapshot().liveNotes).toEqual([]);

    const enabled = createTestHost([createTestNumberedFile()], { stmlEnabled: true });
    const unmeasured = enabled.addLiveComment(
      { filePath: "alpha.ts", hunkIndex: 0, summary: "s", markup: "<b>x</b>" },
      "mcp:2",
    );
    expect(unmeasured.markupWidth).toBeUndefined();

    const measured = enabled.addLiveComment(
      { filePath: "alpha.ts", hunkIndex: 0, summary: "s", markup: "<b>x</b>" },
      "mcp:3",
      { measureMarkup: (_markup, side) => ({ markupWidth: side === "new" ? 42 : 0 }) },
    );
    expect(measured.markupWidth).toBe(42);
  });
});

describe("ReviewSessionHost user notes", () => {
  test("starts, saves, edits, replies to, and removes a reviewer note through intents", () => {
    const host = createTestHost([createTestNumberedFile()]);

    const started = host.startUserNote({ fileId: "alpha", hunkIndex: 0 });
    expect(started?.draft.id).toBe(`draft:alpha:0:${FIXED_NOW}-1`);
    expect(host.updateDraftNote("Ignored", "draft:other")).toBe(false);
    expect(host.updateDraftNote("Looks right.", started?.draft.id)).toBe(true);

    const saved = host.saveDraftNote();
    expect(saved?.note).toMatchObject({ id: `user:${FIXED_NOW}-1`, summary: "Looks right." });
    expect(host.saveDraftNote()).toBeNull();
    expect(host.getReviewNoteSummaries()).toEqual([
      expect.objectContaining({
        noteId: `user:${FIXED_NOW}-1`,
        source: "user",
        author: "user",
        editable: true,
        body: "Looks right.",
      }),
    ]);

    const noteId = `user:${FIXED_NOW}-1`;
    const edit = host.startUserNoteEdit(noteId);
    expect(edit.file?.id).toBe("alpha");
    host.updateDraftNote("Edited.");
    expect(host.saveDraftNote()?.note.summary).toBe("Edited.");

    host.startUserNoteReply(noteId);
    host.updateDraftNote("A reply.");
    const reply = host.saveDraftNote();
    expect(reply?.note.parentId).toBe(noteId);

    host.removeUserNote(reply!.note.id);
    expect(() => host.removeUserNote("user:missing")).toThrow(
      "No user note matches id user:missing.",
    );
    expect(host.clearLiveComments(undefined, { includeUser: true })).toMatchObject({
      removedUserNoteCount: 1,
      remainingUserNoteCount: 0,
    });
  });

  test("refuses a draft for a file or hunk the review does not hold", () => {
    const host = createTestHost([createTestNumberedFile()]);
    expect(host.startUserNote({ fileId: "missing", hunkIndex: 0 })).toBeNull();
    expect(host.startUserNote({ fileId: "alpha", hunkIndex: 3 })).toBeNull();
    expect(host.getSnapshot().draftNote).toBeNull();
  });
});

describe("ReviewSessionHost navigation", () => {
  test("selects absolute targets and lands line targets only through a supplied reveal", () => {
    const host = createTestHost([createTestNumberedFile(), createTestTwoHunkFile()]);

    expect(host.navigateToLocation({ filePath: "beta.ts", hunkIndex: 1 })).toMatchObject({
      fileId: "beta",
      hunkIndex: 1,
      selectedHunk: { index: 1 },
    });
    expect(host.getSelection()).toEqual({ fileId: "beta", hunkIndex: 1 });

    const headless = host.navigateToLocation({ filePath: "alpha.ts", side: "new", line: 8 });
    expect(headless.revealed).toBeUndefined();
    expect(host.getSelection()).toEqual({ fileId: "alpha", hunkIndex: 0 });

    const revealLine: RevealLineFn = () => "line";
    expect(
      host.navigateToLocation({ filePath: "beta.ts", side: "new", line: 20 }, { revealLine }),
    ).toMatchObject({ fileId: "beta", hunkIndex: 1, revealed: "line", side: "new", line: 20 });

    expect(() => host.navigateToLocation({ filePath: "missing.ts", hunkIndex: 0 })).toThrow(
      "missing.ts",
    );
  });

  test("walks annotated hunks from the notes the host holds", () => {
    const host = createTestHost([createTestNumberedFile(), createTestTwoHunkFile()]);
    expect(() => host.navigateToLocation({ commentDirection: "next" })).toThrow(
      "No annotated hunks found in the current review.",
    );

    host.addLiveComment({ filePath: "beta.ts", hunkIndex: 1, summary: "here" }, "mcp:1");
    expect(host.navigateToLocation({ commentDirection: "next" })).toMatchObject({
      fileId: "beta",
      hunkIndex: 1,
    });
    expect(host.getSelection()).toEqual({ fileId: "beta", hunkIndex: 1 });
  });
});

describe("ReviewSessionHost agent highlights", () => {
  test("adds, reveals, and clears attention marks with honest counts", () => {
    const host = createTestHost([createTestNumberedFile(), createTestTwoHunkFile()]);
    let notifications = 0;
    const unsubscribe = host.subscribeAgentLineHighlights(() => {
      notifications += 1;
    });

    const added = host.addAgentLineHighlight({
      filePath: "beta.ts",
      side: "new",
      line: 20,
      start: 0,
      end: 6,
      reveal: true,
    });
    expect(added).toMatchObject({ fileId: "beta", hunkIndex: 1, fileMarkCount: 1 });
    // No measured row was supplied, so the reveal lands on the hunk.
    expect(added.revealed).toBe("hunk");
    expect(host.getSelection()).toEqual({ fileId: "beta", hunkIndex: 1 });

    host.addAgentLineHighlight({ filePath: "alpha.ts", side: "new", line: 8, start: 0, end: 1 });
    expect(host.getAgentLineHighlights().get("alpha")).toHaveLength(1);
    expect(notifications).toBe(2);

    expect(() =>
      host.addAgentLineHighlight({ filePath: "alpha.ts", side: "new", line: 8, start: 3, end: 3 }),
    ).toThrow("is not a valid [start, end) character range");
    expect(() =>
      host.addAgentLineHighlight({ filePath: "alpha.ts", side: "new", line: 1, start: 0, end: 1 }),
    ).toThrow("No new diff hunk in alpha.ts covers line 1.");

    expect(host.clearAgentLineHighlights("alpha.ts")).toEqual({
      removedCount: 1,
      remainingCount: 1,
      filePath: "alpha.ts",
    });
    expect(host.clearAgentLineHighlights()).toEqual({ removedCount: 1, remainingCount: 0 });
    expect(host.getAgentLineHighlights().size).toBe(0);
    unsubscribe();
  });
});

describe("ReviewSessionHost gap expansion", () => {
  test("moves source status from loading to loaded and caches the text", async () => {
    const deferred = createTestDeferred<string | null>();
    const fetcher = createTestSourceFetcher(() => deferred.promise);
    const host = createTestHost([createTestNumberedFile({ sourceFetcher: fetcher })]);

    const toggled = host.toggleGap("alpha", "before:0");
    expect(toggled).toMatchObject({ fileId: "alpha", gapId: "before:0", expanded: true });
    expect(host.getSnapshot().sourceStatusByFileKey).toEqual({
      [host.fileKeyFor("alpha")!]: { kind: "loading" },
    });

    deferred.resolve("full source\n");
    await flushTestMicrotasks();
    expect(Object.values(host.getSnapshot().sourceStatusByFileKey)).toEqual([
      { kind: "loaded", text: "full source\n" },
    ]);

    expect(host.toggleGap("alpha", "before:0")?.expanded).toBe(false);
    expect(host.toggleGap("alpha", "before:0")?.expanded).toBe(true);
    expect(fetcher.calls).toEqual(["new"]);
  });

  test("reports a null source as an error and an over-limit source as too large", async () => {
    const nullHost = createTestHost([
      createTestNumberedFile({ sourceFetcher: createTestSourceFetcher(() => null) }),
    ]);
    nullHost.toggleGap("alpha", "before:0");
    await flushTestMicrotasks();
    expect(Object.values(nullHost.getSnapshot().sourceStatusByFileKey)).toEqual([
      { kind: "error" },
    ]);

    const largeHost = createTestHost([
      createTestNumberedFile({
        sourceFetcher: createTestSourceFetcher(() => {
          throw new SourceTextTooLargeError(1024);
        }),
      }),
    ]);
    largeHost.toggleGap("alpha", "before:0");
    await flushTestMicrotasks();
    expect(Object.values(largeHost.getSnapshot().sourceStatusByFileKey)).toEqual([
      { kind: "error", reason: "too-large" },
    ]);
  });

  test("logs and reports a failed source load", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const host = createTestHost([
        createTestNumberedFile({
          sourceFetcher: createTestSourceFetcher(() => Promise.reject(new Error("disk"))),
        }),
      ]);
      host.toggleGap("alpha", "before:0");
      await flushTestMicrotasks();
      expect(Object.values(host.getSnapshot().sourceStatusByFileKey)).toEqual([
        { kind: "error", reason: undefined },
      ]);
      expect(String(consoleError.mock.calls[0]?.[0])).toContain("failed to load new source");
    } finally {
      consoleError.mockRestore();
    }
  });

  test("does nothing for a file without a source fetcher", () => {
    const host = createTestHost([createTestNumberedFile()]);
    expect(host.toggleGap("alpha", "before:0")).toBeUndefined();
    expect(host.getSnapshot().expandedGaps).toEqual([]);
  });
});

describe("ReviewSessionHost file replacement", () => {
  test("keeps notes and expansion on unchanged files and retires state on changed ones", async () => {
    const host = createTestHost([
      createTestNumberedFile({ sourceFetcher: createTestSourceFetcher(() => "alpha\n") }),
      createTestTwoHunkFile(),
    ]);
    host.toggleGap("alpha", "before:0");
    await flushTestMicrotasks();
    host.addLiveComment({ filePath: "beta.ts", hunkIndex: 0, summary: "kept" }, "mcp:1");
    host.addAgentLineHighlight({ filePath: "beta.ts", side: "new", line: 1, start: 0, end: 1 });
    host.addAgentLineHighlight({ filePath: "alpha.ts", side: "new", line: 8, start: 0, end: 1 });
    const alphaKey = host.fileKeyFor("alpha")!;

    // Identical content keeps the expansion open; unattested source text is refetched.
    expect([
      ...host.replaceFiles([
        createTestNumberedFile({ sourceFetcher: createTestSourceFetcher(() => "alpha\n") }),
        createTestTwoHunkFile(),
      ]),
    ]).toEqual([]);
    await flushTestMicrotasks();
    expect(host.getSnapshot().sourceStatusByFileKey[alphaKey]?.kind).toBe("loaded");
    expect(host.getSnapshot().expandedGaps).toEqual([
      { fileKey: alphaKey, gapId: "before:0", expanded: true },
    ]);
    expect(host.getAgentLineHighlights().size).toBe(2);

    // Changed content retires alpha's expansion, source, and marks; beta keeps its note.
    const retired = host.replaceFiles([
      createTestNumberedFile({
        changedValue: 900,
        sourceFetcher: createTestSourceFetcher(() => "changed\n"),
      }),
      createTestTwoHunkFile(),
    ]);
    expect([...retired]).toEqual([alphaKey]);
    expect(host.getSnapshot().sourceStatusByFileKey[alphaKey]).toBeUndefined();
    expect(host.getSnapshot().expandedGaps.filter((gap) => gap.fileKey === alphaKey)).toEqual([]);
    expect([...host.getAgentLineHighlights().keys()]).toEqual(["beta"]);
    expect(host.getLiveCommentSummaries().map((note) => note.commentId)).toEqual(["mcp:1"]);
  });

  test("a pending source load cannot repopulate state after its content was replaced", async () => {
    const pending = createTestDeferred<string | null>();
    const host = createTestHost([
      createTestNumberedFile({ sourceFetcher: createTestSourceFetcher(() => pending.promise) }),
    ]);
    host.toggleGap("alpha", "before:0");

    host.replaceFiles([
      createTestNumberedFile({
        changedValue: 900,
        sourceFetcher: createTestSourceFetcher(() => "second\n"),
      }),
    ]);
    pending.resolve("first\n");
    await flushTestMicrotasks();
    expect(host.getSnapshot().sourceStatusByFileKey).toEqual({});
  });

  test("drops notes on a file a reload removed from the published summaries", () => {
    const host = createTestHost([createTestNumberedFile(), createTestTwoHunkFile()]);
    host.addLiveComment({ filePath: "beta.ts", hunkIndex: 0, summary: "on beta" }, "mcp:1");

    host.replaceFiles([createTestNumberedFile()]);
    const state = host.getSessionSnapshotState({ publicationGeneration: "g1" });
    expect(state.liveCommentCount).toBe(0);
    expect(state.liveComments).toEqual([]);
    expect(state.selectedFileId).toBe("alpha");
    expect(state.reviewPublication).toEqual({
      generation: "g1",
      stateRevision: host.getSnapshot().stateRevision,
    });
  });
});
