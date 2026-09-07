import { describe, expect, test } from "bun:test";
import {
  createTestReviewState,
  createTestStoredNote,
} from "../../../../../test/helpers/review-store-helpers";
import { createTestReviewFile } from "../../../../../test/helpers/review-store-helpers";
import { reduceReviewState } from "./reducer";
import {
  isReviewGapExpanded,
  reviewFileKeysWithRetiredContent,
  reviewFileMatchesFilter,
  selectActiveReplyableReviewNoteId,
  selectActiveRevealNoteId,
  selectExpandedGapIdsByFileKey,
  selectFallbackFileKey,
  selectNormalizedSelection,
  selectNotesByHunk,
  selectReviewFileByKey,
  selectReviewGapForSelection,
  selectReviewNavigationFiles,
  selectStoredReviewNotes,
  selectThreadedStoredReviewNotes,
  selectVisibleThreadedStoredReviewNotes,
  resolveReviewRevealNoteId,
  selectRevealTarget,
  selectVisibleReviewFiles,
} from "./selectors";

describe("file selectors", () => {
  test("resolve a file by key and reject an unknown one", () => {
    const state = createTestReviewState();

    expect(selectReviewFileByKey(state, "beta")?.key).toBe("beta");
    expect(selectReviewFileByKey(state, "missing")).toBeUndefined();
    expect(selectReviewFileByKey(state, null)).toBeUndefined();
  });
});

describe("reviewFileKeysWithRetiredContent", () => {
  test("names files that left the review or came back with different content", () => {
    const previous = createTestReviewState([
      { key: "alpha", sourceIdentity: "source-1" },
      { key: "beta", sourceIdentity: "source-1" },
      { key: "gamma" },
    ]).document;
    const next = createTestReviewState([
      { key: "alpha", sourceIdentity: "source-1" },
      { key: "beta", sourceIdentity: "source-2" },
      { key: "delta" },
    ]).document;

    expect([...reviewFileKeysWithRetiredContent(previous, next)]).toEqual(["beta", "gamma"]);
  });

  test("retires nothing when the same content is reloaded", () => {
    const document = createTestReviewState([{ key: "alpha", sourceIdentity: "source-1" }]).document;

    expect([...reviewFileKeysWithRetiredContent(document, document)]).toEqual([]);
  });
});

describe("expansion selectors", () => {
  test("report expansion per gap and per file", () => {
    const expanded = [
      { fileKey: "alpha", gapId: "before:1", expanded: true },
      { fileKey: "alpha", gapId: "before:2", expanded: false },
      { fileKey: "beta", gapId: "trailing:0", expanded: true },
    ].reduce(
      (state, gap) => reduceReviewState(state, { type: "expansion/toggle", ...gap }),
      createTestReviewState(),
    );

    expect(isReviewGapExpanded(expanded, "alpha", "before:1")).toBe(true);
    expect(isReviewGapExpanded(expanded, "alpha", "before:2")).toBe(false);
    expect(isReviewGapExpanded(expanded, "gamma", "before:1")).toBe(false);
    expect(selectExpandedGapIdsByFileKey(expanded)).toEqual({
      alpha: new Set(["before:1"]),
      beta: new Set(["trailing:0"]),
    });
  });
});

describe("filter selectors", () => {
  // Intent: one matcher answers for every surface, over every field a reviewer expects.
  test("match a query against path, previous path, and agent summary", () => {
    const file = {
      path: "src/review/stream.ts",
      previousPath: "src/legacy/stream.ts",
      agentSummary: "Rewrites the note placement policy",
    };

    expect(reviewFileMatchesFilter(file, "")).toBe(true);
    expect(reviewFileMatchesFilter(file, "   ")).toBe(true);
    expect(reviewFileMatchesFilter(file, "REVIEW/stream")).toBe(true);
    expect(reviewFileMatchesFilter(file, "legacy")).toBe(true);
    expect(reviewFileMatchesFilter(file, "placement policy")).toBe(true);
    expect(reviewFileMatchesFilter(file, "unrelated")).toBe(false);
  });

  // Intent: a parser's stray line ending must not decide whether a file matches.
  test("normalize paths before matching", () => {
    expect(reviewFileMatchesFilter({ path: "src/alpha.ts\r\n" }, "alpha.ts")).toBe(true);
  });

  test("select visible files and the navigable stream in review order", () => {
    const state = { ...createTestReviewState(["alpha", "beta"]), filter: "beta" };

    expect(selectVisibleReviewFiles(state).map((file) => file.key)).toEqual(["beta"]);
    expect(selectReviewNavigationFiles(state)).toEqual([{ fileKey: "beta", hunkCount: 2 }]);
  });
});

describe("selection selectors", () => {
  // Intent: filtering changes what is browsable, not where the reviewer was looking.
  test("keep a selection the filter hides", () => {
    const state = {
      ...createTestReviewState(["alpha", "beta"]),
      filter: "beta",
      selection: { fileKey: "alpha", hunkIndex: 1 },
    };

    expect(selectNormalizedSelection(state)).toEqual({ fileKey: "alpha", hunkIndex: 1 });
  });

  // Intent: a selection whose file vanished falls back, and reports nothing when it cannot.
  test("fall back only when the document no longer has the selected file", () => {
    const state = {
      ...createTestReviewState(["alpha", "beta"]),
      selection: { fileKey: "vanished", hunkIndex: 3 },
    };

    expect(selectFallbackFileKey(state)).toBe("alpha");
    expect(selectNormalizedSelection(state)).toEqual({ fileKey: "alpha", hunkIndex: 0 });

    const filteredOut = { ...state, filter: "nothing-matches" };
    expect(selectFallbackFileKey(filteredOut)).toBeNull();
    expect(selectNormalizedSelection(filteredOut)).toEqual({ fileKey: null, hunkIndex: 0 });
  });

  test("clamp a stale hunk index onto the file it addresses", () => {
    const state = {
      ...createTestReviewState([{ key: "alpha", hunkCount: 2 }]),
      selection: { fileKey: "alpha", hunkIndex: 9 },
    };

    expect(selectNormalizedSelection(state)).toEqual({ fileKey: "alpha", hunkIndex: 1 });
  });
});

describe("reveal selectors", () => {
  test("resolve the selected hunk's canonical line", () => {
    const state = createTestReviewState(["alpha"]);

    expect(selectRevealTarget(state)).toEqual({ side: "new", line: 1 });
    expect(selectRevealTarget({ ...state, selection: { fileKey: "alpha", hunkIndex: 1 } })).toEqual(
      { side: "new", line: 11 },
    );
    expect(
      selectRevealTarget({ ...state, selection: { fileKey: null, hunkIndex: 0 } }),
    ).toBeUndefined();
  });
});

describe("note selectors", () => {
  test("return every saved note in collection order without drafts or resolution filtering", () => {
    const state = {
      ...createTestReviewState(["alpha"]),
      liveNotes: [
        createTestStoredNote({ id: "live-active", fileKey: "alpha" }),
        createTestStoredNote({ id: "live-orphaned", fileKey: "gone", resolution: "orphaned" }),
      ],
      userNotes: [
        createTestStoredNote({
          id: "user-stale",
          fileKey: "alpha",
          source: "user",
          resolution: "stale",
        }),
      ],
      draftNote: {
        id: "draft:1",
        fileKey: "alpha",
        hunkIndex: 0,
        side: "new" as const,
        line: 1,
        body: "not saved",
      },
    };

    expect(
      selectStoredReviewNotes(state).map((entry) => [entry.note.id, entry.resolution]),
    ).toEqual([
      ["live-active", "active"],
      ["live-orphaned", "orphaned"],
      ["user-stale", "stale"],
    ]);
  });

  test("flattens arbitrarily deep reply trees in deterministic depth-first order", () => {
    const state = {
      ...createTestReviewState(["alpha"], { showAgentNotes: true }),
      liveNotes: [createTestStoredNote({ id: "root", fileKey: "alpha" })],
      userNotes: [
        createTestStoredNote({ id: "child-a", parentId: "root", fileKey: "alpha", source: "user" }),
        createTestStoredNote({ id: "child-b", parentId: "root", fileKey: "alpha", source: "user" }),
        createTestStoredNote({
          id: "grandchild",
          parentId: "child-a",
          fileKey: "alpha",
          source: "user",
        }),
      ],
    };

    expect(
      selectThreadedStoredReviewNotes(state).map(({ entry, rootId, depth }) => ({
        id: entry.note.id,
        rootId,
        depth,
      })),
    ).toEqual([
      { id: "root", rootId: "root", depth: 0 },
      { id: "child-a", rootId: "root", depth: 1 },
      { id: "grandchild", rootId: "root", depth: 2 },
      { id: "child-b", rootId: "root", depth: 1 },
    ]);
    expect(
      selectVisibleThreadedStoredReviewNotes(state).map(
        ({ entry, visibleAncestorHasNextSibling, hasNextVisibleSibling }) => ({
          id: entry.note.id,
          ancestors: visibleAncestorHasNextSibling,
          hasNextSibling: hasNextVisibleSibling,
        }),
      ),
    ).toEqual([
      { id: "root", ancestors: [], hasNextSibling: false },
      { id: "child-a", ancestors: [false], hasNextSibling: true },
      { id: "grandchild", ancestors: [false, true], hasNextSibling: false },
      { id: "child-b", ancestors: [false], hasNextSibling: false },
    ]);
  });

  test("collapses visual depth when an agent parent is hidden", () => {
    const state = {
      ...createTestReviewState(["alpha"], { showAgentNotes: false }),
      liveNotes: [createTestStoredNote({ id: "agent-root", fileKey: "alpha" })],
      userNotes: [
        createTestStoredNote({
          id: "user-reply",
          parentId: "agent-root",
          fileKey: "alpha",
          source: "user",
        }),
      ],
    };

    expect(
      selectVisibleThreadedStoredReviewNotes(state).map(({ entry, visibleDepth }) => ({
        id: entry.note.id,
        visibleDepth,
      })),
    ).toEqual([{ id: "user-reply", visibleDepth: 0 }]);
    expect(selectActiveReplyableReviewNoteId(state)).toBe("user-reply");
  });

  test("group notes by the hunk that owns them, not by range containment", () => {
    const state = {
      ...createTestReviewState(["alpha", "beta"]),
      liveNotes: [
        createTestStoredNote({ id: "live-1", fileKey: "alpha", hunkIndex: 1, line: 11 }),
        createTestStoredNote({ id: "live-2", fileKey: "beta", hunkIndex: 0, line: 1 }),
        createTestStoredNote({
          id: "orphaned",
          fileKey: "alpha",
          hunkIndex: 0,
          resolution: "orphaned" as const,
        }),
      ],
      userNotes: [createTestStoredNote({ id: "user-1", fileKey: "alpha", hunkIndex: 1, line: 12 })],
    };

    const byHunk = selectNotesByHunk(state, "alpha");
    expect([...byHunk.keys()]).toEqual([1]);
    expect(byHunk.get(1)?.map((note) => note.id)).toEqual(["live-1", "user-1"]);
  });

  // Intent: the reviewer's own draft is what a "jump to the note" reveal is about.
  test("prefer an active draft in the selected hunk over stored notes", () => {
    const state = {
      ...createTestReviewState(["alpha"]),
      selection: { fileKey: "alpha", hunkIndex: 0 },
      liveNotes: [createTestStoredNote({ id: "live-1", fileKey: "alpha", line: 2 })],
      draftNote: {
        id: "draft:1",
        fileKey: "alpha",
        hunkIndex: 0,
        side: "new" as const,
        line: 3,
        body: "",
      },
    };

    expect(selectActiveRevealNoteId(state)).toBe("draft:1");
    // A draft being written in another hunk does not steal this hunk's reveal.
    expect(
      selectActiveRevealNoteId({ ...state, draftNote: { ...state.draftNote, hunkIndex: 1 } }),
    ).toBe("live-1");
  });

  test("otherwise take the earliest anchored note in the selected hunk", () => {
    const state = {
      ...createTestReviewState(["alpha"]),
      selection: { fileKey: "alpha", hunkIndex: 0 },
      liveNotes: [
        createTestStoredNote({ id: "live-late", fileKey: "alpha", line: 3 }),
        createTestStoredNote({ id: "live-early", fileKey: "alpha", line: 1 }),
      ],
      userNotes: [createTestStoredNote({ id: "user-late", fileKey: "alpha", line: 2 })],
    };

    expect(selectActiveRevealNoteId(state)).toBe("live-early");
    expect(selectActiveRevealNoteId({ ...state, liveNotes: [], userNotes: [] })).toBeUndefined();
  });

  // Intent: a surface that draws notes the store never held — the terminal's sidecar
  // annotations — asks the same policy which of them a reveal targets.
  test("answer the same way for candidates a surface supplies itself", () => {
    expect(
      resolveReviewRevealNoteId([
        { id: "late", line: 9 },
        { id: "draft", line: 40, draft: true },
        { id: "early", line: 1 },
      ]),
    ).toBe("draft");
    expect(
      resolveReviewRevealNoteId([
        { id: "late", line: 9 },
        { id: "early", line: 1 },
      ]),
    ).toBe("early");
    // Same anchor line: the note that arrived first keeps the reveal.
    expect(
      resolveReviewRevealNoteId([
        { id: "first", line: 4 },
        { id: "second", line: 4 },
      ]),
    ).toBe("first");
    expect(resolveReviewRevealNoteId([])).toBeUndefined();
  });
});

describe("selectReviewGapForSelection", () => {
  test("reaches forward to the next hunk carrying a collapsed gap", () => {
    const state = createTestReviewState([{ key: "alpha", sourceIdentity: "source:alpha" }]);

    // The first test hunk starts the file, so the only leading gap belongs to the second.
    expect(selectReviewGapForSelection(state)).toEqual({
      fileKey: "alpha",
      gapId: "before:1",
    });
  });

  test("prefers the selected hunk's own gap over a later one", () => {
    const state = createTestReviewState([
      { key: "alpha", hunkCount: 3, sourceIdentity: "source:alpha" },
    ]);

    expect(
      selectReviewGapForSelection({ ...state, selection: { fileKey: "alpha", hunkIndex: 2 } }),
    ).toEqual({ fileKey: "alpha", gapId: "before:2" });
  });

  test("falls back to the file's trailing gap when no leading gap is left", () => {
    const file = createTestReviewFile({
      key: "alpha",
      hunkCount: 1,
      sourceIdentity: "source:alpha",
    });
    const state = createTestReviewState();
    const withTrailing = {
      ...state,
      document: {
        files: [
          {
            ...file,
            additionLines: [...file.additionLines, "tail"],
            deletionLines: [...file.deletionLines, "tail"],
          },
        ],
      },
      selection: { fileKey: "alpha", hunkIndex: 0 },
    };

    expect(selectReviewGapForSelection(withTrailing)).toEqual({
      fileKey: "alpha",
      gapId: "trailing:0",
    });
  });

  test("offers nothing for a file with no expandable source behind it", () => {
    expect(selectReviewGapForSelection(createTestReviewState())).toBeUndefined();
  });

  test("offers nothing when the selection reaches no gap at all", () => {
    const state = createTestReviewState([
      { key: "alpha", hunkCount: 1, sourceIdentity: "source:alpha" },
    ]);

    expect(selectReviewGapForSelection(state)).toBeUndefined();
  });
});
